import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type ParsedOutputLine = Record<string, unknown>;

function parseOutputLines(outputLines: string[]): ParsedOutputLine[] {
	return outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ParsedOutputLine);
}

async function startRpcMode(): Promise<{
	lineHandler: (line: string) => void;
	session: AgentSession;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cleanup: () => Promise<void>;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;

	const tempDir = join(tmpdir(), `pi-rpc-compaction-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const model = getModel("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Test model not found");
	}

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "Test",
			tools: [],
		},
		streamFn: (_model, _context, _options) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("summary text") });
				});
			});
			return stream;
		},
	});

	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRegistry = await createInMemoryModelRegistry(authStorage);
	await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader(),
	});

	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;

	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return {
		lineHandler: rpcIo.lineHandler!,
		session,
		sessionManager,
		settingsManager,
		cleanup: async () => {
			try {
				if (session.isStreaming) {
					await session.abort();
				}
			} catch {
				// ignore test cleanup failures
			}
			session.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
	};
}

function seedCompactableSession(
	session: AgentSession,
	sessionManager: SessionManager,
	settingsManager: SettingsManager,
): void {
	settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	sessionManager.appendMessage(createAssistantMessage("assistant response to compact"));
	session.agent.state.messages = sessionManager.buildSessionContext().messages;
}

describe("RPC compaction lifecycle (piri#2)", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it("reports protocol version and capabilities in get_state", async () => {
		const { lineHandler, cleanup } = await startRpcMode();

		try {
			lineHandler(JSON.stringify({ id: "s1", type: "get_state" }));

			await vi.waitFor(() => {
				const responses = parseOutputLines(rpcIo.outputLines).filter(
					(record) => record.id === "s1" && record.type === "response",
				);
				expect(responses).toHaveLength(1);
				const data = responses[0]!.data as Record<string, unknown>;
				expect(data.protocolVersion).toBeGreaterThanOrEqual(1);
				expect(data.capabilities).toContain("compaction_lifecycle_identifiers");
				expect(data.capabilities).toContain("set_append_system_prompt");
			});
		} finally {
			await cleanup();
		}
	});

	it("applies set_append_system_prompt to the session system prompt", async () => {
		const { lineHandler, session, cleanup } = await startRpcMode();

		try {
			lineHandler(JSON.stringify({ id: "a1", type: "set_append_system_prompt", text: "MEMORY-SNAPSHOT-V1" }));

			await vi.waitFor(() => {
				const responses = parseOutputLines(rpcIo.outputLines).filter(
					(record) => record.id === "a1" && record.type === "response",
				);
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({ success: true });
			});
			expect(session.systemPrompt).toContain("MEMORY-SNAPSHOT-V1");

			lineHandler(JSON.stringify({ id: "a2", type: "set_append_system_prompt" }));
			await vi.waitFor(() => {
				const responses = parseOutputLines(rpcIo.outputLines).filter(
					(record) => record.id === "a2" && record.type === "response",
				);
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({ success: true });
			});
			expect(session.systemPrompt).not.toContain("MEMORY-SNAPSHOT-V1");
		} finally {
			await cleanup();
		}
	});

	it("streams compaction_start/end with body-free identifiers on the wire", async () => {
		const { lineHandler, session, sessionManager, settingsManager, cleanup } = await startRpcMode();

		try {
			seedCompactableSession(session, sessionManager, settingsManager);
			rpcIo.outputLines = [];

			lineHandler(JSON.stringify({ id: "c1", type: "compact" }));

			await vi.waitFor(() => {
				const responses = parseOutputLines(rpcIo.outputLines).filter(
					(record) => record.id === "c1" && record.type === "response" && record.command === "compact",
				);
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({ success: true });
			});

			const records = parseOutputLines(rpcIo.outputLines);
			const start = records.find((record) => record.type === "compaction_start");
			const end = records.find((record) => record.type === "compaction_end");
			expect(start).toBeDefined();
			expect(end).toBeDefined();
			expect(start!.sessionId).toBe(session.sessionId);
			expect(end!.sessionId).toBe(session.sessionId);
			expect(end!.aborted).toBe(false);
			expect(typeof end!.compactionEntryId).toBe("string");
			expect(typeof end!.firstKeptEntryId).toBe("string");

			// Ordering: the start event line precedes the end event line.
			expect(records.indexOf(start!)).toBeLessThan(records.indexOf(end!));

			// The persisted compaction entry matches the wire identifiers.
			const entries = sessionManager.getEntries().filter((entry) => entry.type === "compaction");
			expect(entries).toHaveLength(1);
			expect(end!.compactionEntryId).toBe(entries[0]!.id);
			expect(end!.firstKeptEntryId).toBe((entries[0] as { firstKeptEntryId: string }).firstKeptEntryId);
		} finally {
			await cleanup();
		}
	});
});
