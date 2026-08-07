import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { openProgressFile, projectProgressEvent } from "../src/modes/progress-file.ts";

const created: string[] = [];

function tempPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-progress-"));
	created.push(dir);
	return join(dir, "progress.jsonl");
}

afterEach(() => {
	for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("projectProgressEvent", () => {
	it("projects turn and tool boundaries with coarse metadata only", () => {
		const turnStart = projectProgressEvent({ type: "turn_start" } as AgentSessionEvent);
		expect(turnStart?.type).toBe("turn_start");
		expect(turnStart?.ts).toBeDefined();

		const toolStart = projectProgressEvent({
			type: "tool_execution_start",
			toolCallId: "1",
			toolName: "bash",
			args: { command: "secret-command" },
		} as AgentSessionEvent);
		expect(toolStart).toMatchObject({ type: "tool_execution_start", tool: "bash" });
		expect(JSON.stringify(toolStart)).not.toContain("secret-command");

		const toolEnd = projectProgressEvent({
			type: "tool_execution_end",
			toolCallId: "1",
			toolName: "read",
			result: { content: "file contents" },
			isError: false,
		} as AgentSessionEvent);
		expect(toolEnd).toMatchObject({ type: "tool_execution_end", tool: "read", isError: false });
		expect(JSON.stringify(toolEnd)).not.toContain("file contents");
	});

	it("projects retry counters", () => {
		const retry = projectProgressEvent({
			type: "auto_retry_start",
			attempt: 2,
			maxAttempts: 3,
			delayMs: 1000,
			errorMessage: "rate limit detail",
		} as AgentSessionEvent);
		expect(retry).toMatchObject({ type: "auto_retry_start", attempt: 2, maxAttempts: 3 });
		expect(JSON.stringify(retry)).not.toContain("rate limit detail");
	});

	it("skips high-frequency or contentful events", () => {
		expect(
			projectProgressEvent({ type: "message_update", message: {}, assistantMessageEvent: {} } as never),
		).toBeUndefined();
		expect(
			projectProgressEvent({
				type: "tool_execution_update",
				toolCallId: "1",
				toolName: "bash",
				args: {},
				partialResult: {},
			} as AgentSessionEvent),
		).toBeUndefined();
		expect(projectProgressEvent({ type: "bash_execution_update", delta: "x" } as AgentSessionEvent)).toBeUndefined();
		expect(projectProgressEvent({ type: "queue_update" } as never)).toBeUndefined();
	});
});

describe("openProgressFile", () => {
	it("appends JSONL projections and markers", async () => {
		const path = tempPath();
		const writer = await openProgressFile(path);
		writer.write({ type: "turn_start" } as AgentSessionEvent);
		writer.write({ type: "message_update", message: {}, assistantMessageEvent: {} } as never);
		writer.mark("output_schema_retry", { attempt: 1, maxAttempts: 3, errors: ["/status: required"] });
		await writer.close();

		const lines = readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(lines).toHaveLength(2);
		expect(lines[0].type).toBe("turn_start");
		expect(lines[1]).toMatchObject({ type: "marker", marker: "output_schema_retry", attempt: 1, maxAttempts: 3 });
	});

	it("rejects when the path is not openable", async () => {
		await expect(openProgressFile("/nonexistent-dir-xyz/progress.jsonl")).rejects.toThrow();
	});
});
