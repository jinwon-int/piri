import { describe, expect, it } from "vitest";
import { dirnameEnvPath } from "../../src/harness/skills.ts";

/**
 * piri#27 — CodeQL js/polynomial-redos (#5). Trailing separators are trimmed
 * with a scan instead of /[\\/]+$/; the two must agree everywhere.
 */
function original(path: string): string {
	const normalized = path.replace(/[\\/]+$/, "");
	const separatorIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
	if (separatorIndex === 2 && normalized[1] === ":") return normalized.slice(0, 3);
	return separatorIndex <= 0 ? "/" : normalized.slice(0, separatorIndex);
}

function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

describe("dirnameEnvPath", () => {
	it("matches the original implementation on fuzz input", () => {
		const random = seededRandom(5);
		const alphabet = ["/", "\\", "a", "b", ":", "C", "."];
		for (let sample = 0; sample < 5000; sample++) {
			const length = Math.floor(random() * 12);
			let path = "";
			for (let index = 0; index < length; index++) path += alphabet[Math.floor(random() * alphabet.length)];
			expect(dirnameEnvPath(path), JSON.stringify(path)).toBe(original(path));
		}
	});

	it("keeps the documented shapes", () => {
		expect(dirnameEnvPath("/a/b/c.md")).toBe("/a/b");
		expect(dirnameEnvPath("/a/b/c/")).toBe("/a/b");
		expect(dirnameEnvPath("/a/b/c///")).toBe("/a/b");
		expect(dirnameEnvPath("C:\\skills\\x.md")).toBe("C:\\skills");
		expect(dirnameEnvPath("C:\\x.md")).toBe("C:\\");
		expect(dirnameEnvPath("x.md")).toBe("/");
	});

	it("is linear on a long separator run that is not at the end", () => {
		const path = `${"/".repeat(200_000)}x`;
		const start = performance.now();
		dirnameEnvPath(path);
		expect(performance.now() - start).toBeLessThan(500);
	});
});
