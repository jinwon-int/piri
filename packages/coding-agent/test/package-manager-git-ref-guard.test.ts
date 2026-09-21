import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * piri#27 — CodeQL js/second-order-command-line-injection (#28–#31).
 *
 * The ref reaches `git fetch origin <ref>` / `git clone` / `git checkout <ref>`
 * as a positional argument. Two layers refuse an option-looking ref: parsing
 * (parseGitUrl returns null, so the source is not a git source at all) and the
 * package manager itself (a GitSource loaded from settings is re-checked
 * before any git process is spawned).
 */
describe("package manager refuses option-looking git refs (piri#27)", () => {
	let tempDir: string;
	let agentDir: string;
	let packageManager: DefaultPackageManager;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pm-git-ref-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		packageManager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir,
			settingsManager: SettingsManager.inMemory({}),
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("does not treat a source with an --upload-pack ref as a git source", () => {
		const parsed = (packageManager as any).parseSource("git:github.com/user/repo#--upload-pack=touch /tmp/pwned");
		expect(parsed.type).not.toBe("git");
	});

	it("never spawns git for a stored GitSource whose ref looks like an option", async () => {
		const runCommandSpy = vi.spyOn(packageManager as any, "runCommand").mockResolvedValue(undefined);
		const runCommandCaptureSpy = vi.spyOn(packageManager as any, "runCommandCapture").mockResolvedValue("");
		const source = {
			type: "git" as const,
			repo: "https://github.com/user/repo",
			host: "github.com",
			path: "user/repo",
			ref: "--upload-pack=touch /tmp/pwned",
			pinned: true,
		};

		await expect((packageManager as any).installGit(source, "user")).rejects.toThrow(/Refusing git ref/);
		await expect((packageManager as any).updateGit(source, "user")).rejects.toThrow(/Refusing git ref/);

		expect(runCommandSpy).not.toHaveBeenCalled();
		expect(runCommandCaptureSpy).not.toHaveBeenCalled();
	});

	it("still installs a plain pinned ref with the same git arguments as before", async () => {
		const runCommandSpy = vi.spyOn(packageManager as any, "runCommand").mockResolvedValue(undefined);
		vi.spyOn(packageManager as any, "runNpmCommand").mockResolvedValue(undefined);
		const source = {
			type: "git" as const,
			repo: "https://github.com/user/repo",
			host: "github.com",
			path: "user/repo",
			ref: "v1.2.3",
			pinned: true,
		};

		await (packageManager as any).installGit(source, "user");

		const gitCalls = runCommandSpy.mock.calls.filter((call) => call[0] === "git");
		expect(gitCalls[0]?.[1]).toEqual(["clone", "https://github.com/user/repo", expect.any(String)]);
		expect(gitCalls[1]?.[1]).toEqual(["checkout", "v1.2.3"]);
	});
});
