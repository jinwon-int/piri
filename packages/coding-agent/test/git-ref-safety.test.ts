import { describe, expect, it } from "vitest";
import { isUnsafeGitRef, parseGitUrl } from "../src/utils/git.ts";

/**
 * piri#27 — CodeQL js/second-order-command-line-injection.
 *
 * `source.ref` is passed to git as a positional argument. A ref that starts
 * with "-" is parsed by git as an option, and `--upload-pack=<cmd>` runs an
 * arbitrary command on `git fetch`/`git clone`. Package sources can come from a
 * project's settings file, so the ref is not trusted input.
 */
describe("git ref safety (piri#27)", () => {
	it("rejects refs that would be parsed as git options", () => {
		expect(isUnsafeGitRef("--upload-pack=touch /tmp/pwned")).toBe(true);
		expect(isUnsafeGitRef("-x")).toBe(true);
		expect(isUnsafeGitRef("--")).toBe(true);
	});

	it("rejects characters git itself refuses in ref names", () => {
		expect(isUnsafeGitRef("main branch")).toBe(true);
		expect(isUnsafeGitRef("main\n--upload-pack=x")).toBe(true);
		expect(isUnsafeGitRef("a..b")).toBe(true);
		expect(isUnsafeGitRef("v1~1")).toBe(true);
		expect(isUnsafeGitRef("v1^{}")).toBe(true);
		expect(isUnsafeGitRef("a:b")).toBe(true);
		expect(isUnsafeGitRef("a?")).toBe(true);
		expect(isUnsafeGitRef("a*")).toBe(true);
		expect(isUnsafeGitRef("a[b]")).toBe(true);
		expect(isUnsafeGitRef("a\\b")).toBe(true);
		expect(isUnsafeGitRef("main.lock")).toBe(true);
		expect(isUnsafeGitRef("main/")).toBe(true);
		expect(isUnsafeGitRef("")).toBe(true);
	});

	it("accepts ordinary branches, tags and commits", () => {
		for (const ref of [
			"main",
			"feature/x-1",
			"v1.2.3",
			"release-2026.09",
			"abc123def",
			"a".repeat(40),
			"@upstream",
		]) {
			expect(isUnsafeGitRef(ref), ref).toBe(false);
		}
	});

	it("parseGitUrl refuses option-looking refs in every URL shape", () => {
		const bad = "--upload-pack=touch /tmp/pwned";
		expect(parseGitUrl(`git:github.com/user/repo#${bad}`)).toBeNull();
		expect(parseGitUrl(`git:github.com/user/repo@${bad}`)).toBeNull();
		expect(parseGitUrl(`https://github.com/user/repo#${bad}`)).toBeNull();
		expect(parseGitUrl(`https://github.com/user/repo@${bad}`)).toBeNull();
		expect(parseGitUrl(`ssh://git@github.com/user/repo@${bad}`)).toBeNull();
		expect(parseGitUrl(`git:git@github.com:user/repo@${bad}`)).toBeNull();
		expect(parseGitUrl(`git:git@example.internal:team/repo@-x`)).toBeNull();
	});

	it("parseGitUrl still accepts a plain ref", () => {
		const parsed = parseGitUrl("git:github.com/user/repo#v1.2.3");
		expect(parsed).not.toBeNull();
		expect(parsed?.ref).toBe("v1.2.3");
		expect(parsed?.pinned).toBe(true);
	});
});
