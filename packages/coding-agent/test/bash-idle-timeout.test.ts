import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type BashOperations,
	createBashTool,
	createBashToolDefinition,
	DEFAULT_IDLE_TIMEOUT_SECONDS,
	IDLE_TIMEOUT_ENV,
	resolveIdleTimeoutMs,
} from "../src/core/tools/bash.ts";

function nodeCommand(script: string): string {
	return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntilDead(pid: number, timeoutMs = 3000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isAlive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return !isAlive(pid);
}

describe("bash tool idle (no-output) timeout", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "pi-bash-idle-"));
		vi.stubEnv(IDLE_TIMEOUT_ENV, undefined);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(testDir, { recursive: true, force: true });
	});

	it("stops a silent command without an explicit timeout and kills it", async () => {
		const pidFile = join(testDir, "child.pid");
		const command = nodeCommand(
			`require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
		);
		const bash = createBashTool(testDir, { idleTimeout: 0.3 });

		await expect(bash.execute("idle-silent", { command })).rejects.toThrow(
			"Command stopped: no output for 0.3 seconds",
		);

		const pid = Number(readFileSync(pidFile, "utf-8"));
		expect(await waitUntilDead(pid)).toBe(true);
	});

	it("keeps the output produced before the idle stop", async () => {
		const command = nodeCommand(`console.log("before-hang"); setInterval(() => {}, 1000);`);
		const bash = createBashTool(testDir, { idleTimeout: 0.3 });

		await expect(bash.execute("idle-partial", { command })).rejects.toThrow(
			/before-hang\n+Command stopped: no output for 0\.3 seconds/,
		);
	});

	it("does not stop a command that keeps producing output past the idle window", async () => {
		const command = nodeCommand(
			`let i = 0; const t = setInterval(() => { console.log("tick-" + i++); if (i >= 8) clearInterval(t); }, 100);`,
		);
		const bash = createBashTool(testDir, { idleTimeout: 0.3 });

		const startedAt = Date.now();
		const result = await bash.execute("idle-chatty", { command });

		expect(Date.now() - startedAt).toBeGreaterThan(300);
		expect(getTextOutput(result)).toContain("tick-7");
	});

	it("does not apply the idle timeout when an explicit timeout is given", async () => {
		const command = nodeCommand(`setTimeout(() => console.log("done"), 600);`);
		const bash = createBashTool(testDir, { idleTimeout: 0.1 });

		const result = await bash.execute("explicit-timeout-silent", { command, timeout: 5 });

		expect(getTextOutput(result)).toContain("done");
	});

	it("keeps the explicit timeout behavior unchanged", async () => {
		const command = nodeCommand("setInterval(() => {}, 1000)");
		const bash = createBashTool(testDir, { idleTimeout: 60 });

		await expect(bash.execute("explicit-timeout", { command, timeout: 0.2 })).rejects.toThrow(
			"Command timed out after 0.2 seconds",
		);
	});

	it("reads the idle window from PI_SHELL_IDLE_TIMEOUT", async () => {
		vi.stubEnv(IDLE_TIMEOUT_ENV, "0.3");
		const bash = createBashTool(testDir);

		await expect(bash.execute("idle-env", { command: nodeCommand("setInterval(() => {}, 1000)") })).rejects.toThrow(
			"Command stopped: no output for 0.3 seconds",
		);
	});

	it("still reports a user abort as an abort", async () => {
		const controller = new AbortController();
		const bash = createBashTool(testDir, { idleTimeout: 60 });
		const promise = bash.execute(
			"idle-user-abort",
			{ command: nodeCommand("setInterval(() => {}, 1000)") },
			controller.signal,
		);
		setTimeout(() => controller.abort(), 200);

		await expect(promise).rejects.toThrow("Command aborted");
	});

	it("applies to custom operations through the abort signal", async () => {
		const operations: BashOperations = {
			exec: (_command, _cwd, { signal }) =>
				new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		};
		const bash = createBashTool(testDir, { operations, idleTimeout: 0.1 });

		await expect(bash.execute("idle-custom-ops", { command: "hang" })).rejects.toThrow(
			"Command stopped: no output for 0.1 seconds",
		);
	});

	it("resolves the idle window from option, then env, then the 30 minute default", () => {
		expect(DEFAULT_IDLE_TIMEOUT_SECONDS).toBe(1800);
		expect(resolveIdleTimeoutMs()).toBe(1_800_000);
		expect(resolveIdleTimeoutMs(5)).toBe(5000);
		expect(resolveIdleTimeoutMs(0)).toBeUndefined();

		vi.stubEnv(IDLE_TIMEOUT_ENV, "120");
		expect(resolveIdleTimeoutMs()).toBe(120_000);
		expect(resolveIdleTimeoutMs(5)).toBe(5000);

		vi.stubEnv(IDLE_TIMEOUT_ENV, "0");
		expect(resolveIdleTimeoutMs()).toBeUndefined();

		for (const invalid of ["abc", "-1", ""]) {
			vi.stubEnv(IDLE_TIMEOUT_ENV, invalid);
			expect(resolveIdleTimeoutMs()).toBe(1_800_000);
		}
		vi.stubEnv(IDLE_TIMEOUT_ENV, undefined);
		expect(resolveIdleTimeoutMs(Number.NaN)).toBe(1_800_000);
		expect(resolveIdleTimeoutMs(-1)).toBe(1_800_000);
	});

	it("describes the default idle window in the tool description", () => {
		expect(createBashToolDefinition(testDir).description).toContain(
			"without one, a command that produces no output for 30 min is stopped",
		);
		expect(createBashToolDefinition(testDir, { idleTimeout: 0 }).description).toContain(
			"Optionally provide a timeout in seconds.",
		);
	});
});
