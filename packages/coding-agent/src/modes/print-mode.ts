/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pi -p "prompt"` - text output
 * - `pi --mode json "prompt"` - JSON event stream
 */

import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { flushRawStdout, waitForRawStdoutBackpressure, writeRawStdout } from "../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";
import { toJsonEvent } from "./json-event.ts";
import {
	buildSchemaFeedback,
	compileOutputSchema,
	extractJsonCandidate,
	loadOutputSchema,
	repairRootAdditionalProperties,
} from "./output-schema.ts";
import { openProgressFile, type ProgressFileWriter } from "./progress-file.ts";

/**
 * Print mode exit code contract (stable; consumed by the A2A docker runner
 * profile and the broker analysis bridge, jinwon-int/a2a-nexus#1745):
 * - 0: success — stdout holds the final answer (schema-validated when
 *   --output-schema is set)
 * - 1: unexpected internal error
 * - 2: local usage/configuration error (bad flag combination, unreadable
 *   --output-schema/--progress-file path) — nothing reached the provider
 * - 3: provider/request failure — the model request errored or was aborted
 * - 4: --output-schema not satisfied within the attempt budget
 * Signal deaths use 129 (SIGHUP) / 143 (SIGTERM).
 */
export const PRINT_EXIT = {
	success: 0,
	internalError: 1,
	usageError: 2,
	requestFailure: 3,
	schemaUnsatisfied: 4,
} as const;

/**
 * Aggregated provider usage for one print-mode run. Content-free and
 * machine-sized so wrappers (docker runner, broker bridge) can attribute
 * cost/latency per task without parsing message content.
 */
export interface PrintUsageSummary {
	/** Assistant responses observed during this run (== provider round-trips). */
	requests: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	/** Total provider-reported cost in USD (sum of message cost.total). */
	costUsd: number;
	/** Unique "provider/model" pairs that produced assistant messages. */
	models: string[];
}

/**
 * Sum usage over assistant messages added during this run; messages already
 * present when the run started (resumed history) are excluded by startIndex.
 */
export function summarizeUsage(messages: ReadonlyArray<{ role: string }>, startIndex = 0): PrintUsageSummary {
	const summary: PrintUsageSummary = {
		requests: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		costUsd: 0,
		models: [],
	};
	const seen = new Set<string>();
	for (const message of messages.slice(startIndex)) {
		if (message.role !== "assistant") continue;
		const assistant = message as AssistantMessage;
		const usage = assistant.usage;
		if (!usage) continue;
		summary.requests += 1;
		summary.inputTokens += usage.input;
		summary.outputTokens += usage.output;
		summary.cacheReadTokens += usage.cacheRead;
		summary.cacheWriteTokens += usage.cacheWrite;
		summary.totalTokens += usage.totalTokens;
		summary.costUsd += usage.cost?.total ?? 0;
		const model = `${assistant.provider}/${assistant.model}`;
		if (!seen.has(model)) {
			seen.add(model);
			summary.models.push(model);
		}
	}
	summary.costUsd = Number(summary.costUsd.toFixed(6));
	return summary;
}

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/**
	 * Path to a JSON Schema the final assistant message must satisfy (text
	 * mode only). On violation the model is re-prompted with the validator
	 * errors; the run exits non-zero without printing stdout output when the
	 * attempt budget is exhausted. (piri A2A worker Phase 0, a2a-nexus#1745)
	 */
	outputSchema?: string;
	/**
	 * Path to a JSONL progress file appended with compact, content-free
	 * session events (turns, tools, retries). Lets outer wrappers tell
	 * "working" from "stuck" via file mtime/content. (a2a-nexus#1745 item 2)
	 */
	progressFile?: string;
}

/** Total attempts for schema-satisfying output (initial + retries). */
const OUTPUT_SCHEMA_DEFAULT_ATTEMPTS = 3;
const OUTPUT_SCHEMA_MAX_ATTEMPTS = 10;

function resolveOutputSchemaAttempts(): number {
	const raw = process.env.PI_OUTPUT_SCHEMA_ATTEMPTS;
	if (!raw) return OUTPUT_SCHEMA_DEFAULT_ATTEMPTS;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 1) return OUTPUT_SCHEMA_DEFAULT_ATTEMPTS;
	return Math.min(parsed, OUTPUT_SCHEMA_MAX_ATTEMPTS);
}

/** Repaired-key names recorded on the progress marker (bounded, metadata-only). */
const MAX_REPAIRED_KEY_NAMES = 8;
const MAX_REPAIRED_KEY_LENGTH = 64;

/** Deterministic remove-only repair is on by default; "0" disables it. */
function schemaRepairEnabled(): boolean {
	return process.env.PI_OUTPUT_SCHEMA_REPAIR !== "0";
}

function boundRepairKeyName(key: string): string {
	return key.length > MAX_REPAIRED_KEY_LENGTH ? `${key.slice(0, MAX_REPAIRED_KEY_LENGTH)}…` : key;
}

/** Concatenate the text contents of an assistant message. */
function assistantText(message: AssistantMessage): string {
	let text = "";
	for (const content of message.content) {
		if (content.type === "text") text += content.text;
	}
	return text;
}

/**
 * Validate the final assistant text against --output-schema, re-prompting
 * with validator errors on violation. Prints the validated JSON only;
 * contract-violating output never reaches stdout.
 */
async function emitSchemaValidatedOutput(
	session: AgentSessionRuntime["session"],
	firstMessage: AssistantMessage,
	schemaPath: string,
	progress?: ProgressFileWriter,
): Promise<number> {
	let validator: ReturnType<typeof compileOutputSchema>;
	let schema: TSchema;
	try {
		schema = await loadOutputSchema(schemaPath);
		validator = compileOutputSchema(schema);
	} catch (error: unknown) {
		console.error(`Invalid --output-schema ${schemaPath}: ${error instanceof Error ? error.message : String(error)}`);
		return PRINT_EXIT.usageError;
	}

	const maxAttempts = resolveOutputSchemaAttempts();
	let message = firstMessage;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			console.error(message.errorMessage || `Request ${message.stopReason}`);
			return PRINT_EXIT.requestFailure;
		}
		let errors: string[] = [];
		const candidate = extractJsonCandidate(assistantText(message));
		if (candidate !== undefined) {
			try {
				const value: unknown = JSON.parse(candidate);
				if (validator.check(value)) {
					writeRawStdout(`${JSON.stringify(value)}\n`);
					return PRINT_EXIT.success;
				}
				errors = validator.errors(value);
				// a2a-nexus#1815 item 2: deterministic remove-only repair BEFORE
				// any provider resend — the dominant retry shape (extra root keys
				// under additionalProperties:false) is fixable locally. The repair
				// only deletes schema-forbidden root keys; success still requires a
				// full validator.check pass, so no generic wrapper or arbitrary JSON
				// is promoted. Failures fall through to the resend below unchanged.
				if (schemaRepairEnabled()) {
					const repaired = repairRootAdditionalProperties(schema, value);
					if (repaired && validator.check(repaired.value)) {
						progress?.mark("output_schema_repaired", {
							attempt,
							dropped: repaired.droppedKeys.length,
							keys: repaired.droppedKeys.slice(0, MAX_REPAIRED_KEY_NAMES).map(boundRepairKeyName),
						});
						writeRawStdout(`${JSON.stringify(repaired.value)}\n`);
						return PRINT_EXIT.success;
					}
				}
			} catch {
				errors = ["output candidate was not parseable JSON"];
			}
		}
		if (attempt === maxAttempts) break;
		progress?.mark("output_schema_retry", { attempt, maxAttempts, errors });
		await session.prompt(buildSchemaFeedback(errors));
		const next = session.state.messages[session.state.messages.length - 1];
		if (next?.role !== "assistant") {
			console.error("--output-schema retry produced no assistant message");
			return PRINT_EXIT.requestFailure;
		}
		message = next as AssistantMessage;
	}
	console.error(`--output-schema not satisfied after ${maxAttempts} attempt(s); no output printed`);
	return PRINT_EXIT.schemaUnsatisfied;
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	// Schema validation applies to the final text answer; a JSON event stream
	// would already have streamed unvalidated content by then.
	if (options.outputSchema && mode !== "text") {
		console.error("--output-schema requires text print mode (pi -p)");
		return PRINT_EXIT.usageError;
	}
	let exitCode = 0;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;
	let progress: ProgressFileWriter | undefined;
	if (options.progressFile) {
		try {
			progress = await openProgressFile(options.progressFile);
		} catch (error: unknown) {
			console.error(
				`Cannot open --progress-file ${options.progressFile}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return PRINT_EXIT.usageError;
		}
	}
	let disposed = false;
	const signalCleanupHandlers: Array<() => void> = [];
	// Index into session.state.messages where this run's messages begin; set
	// after the initial rebind so resumed history is excluded from usage.
	let runStartIndex = 0;

	/**
	 * Report aggregate provider usage exactly once per run, on the two
	 * machine-readable surfaces wrappers already watch: a content-free
	 * progress-file marker and a greppable PIRI_USAGE=<json> stderr line.
	 * Never throws — usage reporting must not change the run's outcome.
	 */
	const emitUsageSummary = (): void => {
		try {
			const summary = summarizeUsage(session.state.messages, runStartIndex);
			progress?.mark("usage", { ...summary });
			console.error(`PIRI_USAGE=${JSON.stringify(summary)}`);
		} catch {
			// best-effort telemetry only
		}
	};

	const disposeRuntime = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		unsubscribe?.();
		unsubscribeBackpressure?.();
		await runtimeHost.dispose();
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void disposeRuntime().finally(() => {
					process.exit(signal === "SIGHUP" ? 129 : 143);
				});
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	registerSignalHandlers();

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.bindExtensions({
			mode: mode === "json" ? "json" : "print",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, switchOptions) => {
					return runtimeHost.switchSession(sessionPath, switchOptions);
				},
				reload: async () => {
					await session.reload();
				},
			},
			onError: (err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		});

		unsubscribe?.();
		unsubscribeBackpressure?.();
		unsubscribe = session.subscribe((event) => {
			progress?.write(event);
			if (mode === "json") {
				writeRawStdout(`${JSON.stringify(toJsonEvent(event))}\n`);
			}
		});
		unsubscribeBackpressure =
			mode === "json"
				? session.agent.subscribe(async () => {
						await waitForRawStdoutBackpressure();
					})
				: undefined;
	};

	try {
		if (mode === "json") {
			const header = session.sessionManager.getHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		await rebindSession();
		runStartIndex = session.state.messages.length;

		if (initialMessage) {
			await session.prompt(initialMessage, { images: initialImages });
		}

		for (const message of messages) {
			await session.prompt(message);
		}

		if (mode === "text") {
			const state = session.state;
			const lastMessage = state.messages[state.messages.length - 1];

			if (lastMessage?.role === "assistant") {
				const assistantMsg = lastMessage as AssistantMessage;
				if (options.outputSchema) {
					exitCode = await emitSchemaValidatedOutput(session, assistantMsg, options.outputSchema, progress);
				} else if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
					console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
					exitCode = PRINT_EXIT.requestFailure;
				} else {
					for (const content of assistantMsg.content) {
						if (content.type === "text") {
							writeRawStdout(`${content.text}\n`);
						}
					}
				}
			}
		}

		return exitCode;
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : String(error));
		return PRINT_EXIT.internalError;
	} finally {
		emitUsageSummary();
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await disposeRuntime();
		await progress?.close().catch(() => {});
		await flushRawStdout();
	}
}
