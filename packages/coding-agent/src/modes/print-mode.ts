/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pi -p "prompt"` - text output
 * - `pi --mode json "prompt"` - JSON event stream
 */

import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { flushRawStdout, waitForRawStdoutBackpressure, writeRawStdout } from "../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";
import { toJsonEvent } from "./json-event.ts";
import { buildSchemaFeedback, compileOutputSchema, extractJsonCandidate, loadOutputSchema } from "./output-schema.ts";

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
): Promise<number> {
	let validator: ReturnType<typeof compileOutputSchema>;
	try {
		validator = compileOutputSchema(await loadOutputSchema(schemaPath));
	} catch (error: unknown) {
		console.error(`Invalid --output-schema ${schemaPath}: ${error instanceof Error ? error.message : String(error)}`);
		return 2;
	}

	const maxAttempts = resolveOutputSchemaAttempts();
	let message = firstMessage;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			console.error(message.errorMessage || `Request ${message.stopReason}`);
			return 1;
		}
		let errors: string[] = [];
		const candidate = extractJsonCandidate(assistantText(message));
		if (candidate !== undefined) {
			try {
				const value: unknown = JSON.parse(candidate);
				if (validator.check(value)) {
					writeRawStdout(`${JSON.stringify(value)}\n`);
					return 0;
				}
				errors = validator.errors(value);
			} catch {
				errors = ["output candidate was not parseable JSON"];
			}
		}
		if (attempt === maxAttempts) break;
		await session.prompt(buildSchemaFeedback(errors));
		const next = session.state.messages[session.state.messages.length - 1];
		if (next?.role !== "assistant") {
			console.error("--output-schema retry produced no assistant message");
			return 1;
		}
		message = next as AssistantMessage;
	}
	console.error(`--output-schema not satisfied after ${maxAttempts} attempt(s); no output printed`);
	return 1;
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
		return 2;
	}
	let exitCode = 0;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;
	let disposed = false;
	const signalCleanupHandlers: Array<() => void> = [];

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
					exitCode = await emitSchemaValidatedOutput(session, assistantMsg, options.outputSchema);
				} else if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
					console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
					exitCode = 1;
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
		return 1;
	} finally {
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await disposeRuntime();
		await flushRawStdout();
	}
}
