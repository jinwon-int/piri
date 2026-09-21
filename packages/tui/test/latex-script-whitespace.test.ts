import assert from "node:assert";
import { describe, it } from "node:test";
import { stripOperatorWhitespace } from "../src/latex.ts";

/**
 * piri#27 — CodeQL js/polynomial-redos (#11). formatScript() used a global
 * "\s* ([=+-]) \s*" -> "$1" replacement; the single-pass version must agree
 * with that regex everywhere and stay linear on long whitespace runs.
 */
function original(value: string): string {
	return value.replace(/\s*([=+-])\s*/g, "$1");
}

function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

describe("stripOperatorWhitespace", () => {
	it("matches the original regex on fuzz input", () => {
		const random = seededRandom(11);
		const alphabet = [" ", "\t", "\n", "=", "+", "-", "a", "1", " "];
		for (let sample = 0; sample < 5000; sample++) {
			const length = Math.floor(random() * 14);
			let value = "";
			for (let index = 0; index < length; index++) value += alphabet[Math.floor(random() * alphabet.length)];
			assert.strictEqual(stripOperatorWhitespace(value), original(value), JSON.stringify(value));
		}
	});

	it("keeps the documented shapes", () => {
		assert.strictEqual(stripOperatorWhitespace("n + 1"), "n+1");
		assert.strictEqual(stripOperatorWhitespace("a  b"), "a  b");
		assert.strictEqual(stripOperatorWhitespace("i = j - 2"), "i=j-2");
		assert.strictEqual(stripOperatorWhitespace(" - x"), "-x");
	});

	it("is linear on a long whitespace run with no operator", () => {
		const value = `a${"\t".repeat(200_000)}b`;
		const start = performance.now();
		stripOperatorWhitespace(value);
		assert.ok(performance.now() - start < 500);
	});
});
