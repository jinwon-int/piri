import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionShutdownEvent } from "../src/index.ts";
import { runPrintMode } from "../src/modes/print-mode.ts";

type EmitEvent = SessionShutdownEvent;

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type FakeSession = {
	sessionManager: { getHeader: () => object | undefined };
	agent: { waitForIdle: () => Promise<void>; subscribe: ReturnType<typeof vi.fn> };
	state: { messages: AssistantMessage[] };
	extensionRunner: FakeExtensionRunner;
	bindExtensions: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	reload: ReturnType<typeof vi.fn>;
};

type FakeRuntimeHost = {
	session: FakeSession;
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
};

function createAssistantMessage(options?: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: options?.text ? [{ type: "text", text: options.text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		errorMessage: options?.errorMessage,
		timestamp: Date.now(),
	};
}

function createRuntimeHost(assistantMessage: AssistantMessage): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages: [assistantMessage] };

	const session: FakeSession = {
		sessionManager: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {}, subscribe: vi.fn(() => () => {}) },
		state,
		extensionRunner,
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		prompt: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
	};

	return {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}),
		setRebindSession: vi.fn(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runPrintMode", () => {
	it("emits session_shutdown in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			initialMessage: "Say done",
			initialImages: images,
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("Say done", { images });
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("hello");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown and returns non-zero on assistant error", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
		);
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("provider failure");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});
});

describe("runPrintMode --output-schema", () => {
	const schema = {
		type: "object",
		required: ["status", "summary"],
		additionalProperties: false,
		properties: { status: { type: "string", enum: ["done", "blocked"] }, summary: { type: "string" } },
	};

	function writeSchema(): string {
		const path = `${mkdtempSync(join(tmpdir(), "pi-schema-"))}schema.json`;
		writeFileSync(path, JSON.stringify(schema));
		return path;
	}

	/** Host whose prompt() pushes the next scripted assistant message. */
	function createScriptedHost(script: AssistantMessage[]) {
		const state = { messages: [script[0]] };
		let calls = 0;
		const session = {
			sessionManager: { getHeader: () => undefined },
			agent: { waitForIdle: async () => {}, subscribe: vi.fn(() => () => {}) },
			state,
			extensionRunner: { hasHandlers: () => false, emit: vi.fn(async () => {}) },
			bindExtensions: vi.fn(async () => {}),
			subscribe: vi.fn(() => () => {}),
			prompt: vi.fn(async (..._args: unknown[]) => {
				calls += 1;
				if (script[calls]) state.messages.push(script[calls]);
			}),
			reload: vi.fn(async () => {}),
		};
		return {
			session,
			newSession: vi.fn(async () => undefined),
			fork: vi.fn(async () => ({ selectedText: "" })),
			switchSession: vi.fn(async () => undefined),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		};
	}

	function stdoutSpy() {
		let text = "";
		// output-guard resolves writes only when the write callback fires —
		// a capturing spy must invoke it or flushRawStdout() hangs forever.
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown, encodingOrCb?: unknown, cb?: unknown) => {
			text += String(chunk);
			const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
			if (typeof callback === "function") (callback as (error?: Error | null) => void)(null);
			return true;
		}) as never);
		return () => text;
	}

	it("prints validated JSON and prompts only once", async () => {
		const host = createScriptedHost([createAssistantMessage({ text: '{"status":"done","summary":"ok"}' })]);
		const read = stdoutSpy();

		const exitCode = await runPrintMode(host as never, {
			mode: "text",
			initialMessage: "task",
			outputSchema: writeSchema(),
		});

		expect(exitCode).toBe(0);
		expect(host.session.prompt).toHaveBeenCalledTimes(1);
		expect(read()).toBe('{"status":"done","summary":"ok"}\n');
	});

	it("unwraps fenced JSON before validating", async () => {
		const host = createScriptedHost([
			createAssistantMessage({ text: '```json\n{"status":"done","summary":"ok"}\n```' }),
		]);
		stdoutSpy();

		const exitCode = await runPrintMode(host as never, { mode: "text", outputSchema: writeSchema() });
		expect(exitCode).toBe(0);
	});

	it("re-prompts with validator errors until the answer complies", async () => {
		const host = createScriptedHost([
			createAssistantMessage({ text: "The status is done." }),
			createAssistantMessage({ text: '{"status":"done","summary":"fixed"}' }),
		]);
		const read = stdoutSpy();

		const exitCode = await runPrintMode(host as never, { mode: "text", outputSchema: writeSchema() });

		expect(exitCode).toBe(0);
		// no initialMessage: the only prompt call is the schema feedback retry
		expect(host.session.prompt).toHaveBeenCalledTimes(1);
		expect(String(host.session.prompt.mock.calls[0][0])).toContain("did not satisfy the required output schema");
		expect(read()).toBe('{"status":"done","summary":"fixed"}\n');
	});

	it("exits 1 without printing when the attempt budget runs out", async () => {
		const host = createScriptedHost([
			createAssistantMessage({ text: "no json" }),
			createAssistantMessage({ text: '{"status":"maybe"}' }),
			createAssistantMessage({ text: '{"summary":"still missing status"}' }),
		]);
		const read = stdoutSpy();
		vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(host as never, { mode: "text", outputSchema: writeSchema() });

		expect(exitCode).toBe(1);
		expect(host.session.prompt).toHaveBeenCalledTimes(2);
		expect(read()).toBe("");
	});

	it("exits 2 for an unreadable schema file", async () => {
		const host = createScriptedHost([createAssistantMessage({ text: '{"status":"done","summary":"ok"}' })]);
		stdoutSpy();
		vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(host as never, {
			mode: "text",
			outputSchema: "/nonexistent/schema.json",
		});
		expect(exitCode).toBe(2);
	});

	it("rejects --mode json combined with --output-schema", async () => {
		const host = createScriptedHost([createAssistantMessage({ text: "{}" })]);
		stdoutSpy();
		vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(host as never, {
			mode: "json",
			outputSchema: writeSchema(),
		});
		expect(exitCode).toBe(2);
		expect(host.session.prompt).not.toHaveBeenCalled();
	});
});
