import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseSkillBlock } from "../src/core/agent-session.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { substituteArgs } from "../src/core/prompt-templates.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { parseDiffLine } from "../src/modes/interactive/components/diff.ts";
import { extractJsonCandidate } from "../src/modes/output-schema.ts";

/**
 * piri#27 — CodeQL js/polynomial-redos (#6, #7, #8, #9, #10).
 *
 * Each parser below replaced a backtracking regex with a linear scan (or a
 * regex that cannot backtrack across the input). Two guards per parser:
 *
 * 1. Differential parity: a seeded fuzzer compares the new implementation
 *    with the exact regex it replaced, over alphabets built from the
 *    characters that regex cares about. Any divergence is a behaviour change.
 * 2. Time bound: the input CodeQL described (or a close cousin) at a size
 *    where the old regex took seconds must finish in well under a second.
 */

function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x1_0000_0000;
	};
}

function fuzz(alphabet: string[], samples: number, maxLength: number, seed: number): string[] {
	const random = seededRandom(seed);
	const out: string[] = [];
	for (let index = 0; index < samples; index++) {
		const length = Math.floor(random() * maxLength);
		let value = "";
		for (let position = 0; position < length; position++) {
			value += alphabet[Math.floor(random() * alphabet.length)];
		}
		out.push(value);
	}
	return out;
}

function timed(fn: () => unknown): number {
	const start = performance.now();
	fn();
	return performance.now() - start;
}

const TIME_BUDGET_MS = 500;

describe("parseSkillBlock (#6)", () => {
	function original(text: string) {
		const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
		if (!match) return null;
		return { name: match[1], location: match[2], content: match[3], userMessage: match[4]?.trim() || undefined };
	}

	it("matches the original regex on structured fuzz input", () => {
		const pieces = ['<skill name="', '" location="', '">\n', "\n</skill>", "\n\n", "\n", '"', "a", " ", "x"];
		for (const sample of fuzz(pieces, 3000, 14, 27)) {
			expect(parseSkillBlock(sample), JSON.stringify(sample)).toEqual(original(sample));
		}
	});

	it("keeps the documented shapes", () => {
		expect(parseSkillBlock('<skill name="n" location="/l">\nbody\n</skill>')).toEqual({
			name: "n",
			location: "/l",
			content: "body",
			userMessage: undefined,
		});
		expect(parseSkillBlock('<skill name="n" location="/l">\nbody\n</skill>\n\n  do it  ')).toEqual({
			name: "n",
			location: "/l",
			content: "body",
			userMessage: "do it",
		});
		expect(parseSkillBlock('<skill name="n" location="/l">\na\n</skill>\nb\n</skill>')).toEqual({
			name: "n",
			location: "/l",
			content: "a\n</skill>\nb",
			userMessage: undefined,
		});
		expect(parseSkillBlock('<skill name="n" location="/l">\nbody\n</skill>\n\n')).toBeNull();
		expect(parseSkillBlock("no block")).toBeNull();
	});

	it("is linear on many closing tags without a valid trailer", () => {
		const text = `<skill name="!" location="!">\n\n</skill>\n\n${"\n</skill>\n\na".repeat(20_000)}\n`;
		expect(timed(() => parseSkillBlock(text))).toBeLessThan(TIME_BUDGET_MS);
	});
});

describe("parseDiffLine (#9)", () => {
	function original(line: string) {
		const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
		if (!match) return null;
		return { prefix: match[1], lineNum: match[2], content: match[3] };
	}

	it("matches the original regex on fuzz input", () => {
		for (const sample of fuzz(["+", "-", " ", "\t", "1", "2", "a", "\n", " "], 5000, 12, 9)) {
			expect(parseDiffLine(sample), JSON.stringify(sample)).toEqual(original(sample));
		}
	});

	it("keeps the documented shapes", () => {
		expect(parseDiffLine("+123 content")).toEqual({ prefix: "+", lineNum: "123", content: "content" });
		expect(parseDiffLine("-  4 x")).toEqual({ prefix: "-", lineNum: "  4", content: "x" });
		expect(parseDiffLine("     ...")).toEqual({ prefix: " ", lineNum: "   ", content: "..." });
		expect(parseDiffLine("+ 12")).toEqual({ prefix: "+", lineNum: "", content: "12" });
		expect(parseDiffLine("+12x")).toBeNull();
		expect(parseDiffLine("x 1 y")).toBeNull();
	});

	it("is linear on a long whitespace-only line", () => {
		const line = `\t${"\t\t".repeat(50_000)}`;
		expect(timed(() => parseDiffLine(line))).toBeLessThan(TIME_BUDGET_MS);
	});
});

describe("extractJsonCandidate fence matching (#10)", () => {
	it("still unwraps fenced payloads", () => {
		expect(extractJsonCandidate('```json\n{"a":1}\n```')).toBe('{"a":1}');
		expect(extractJsonCandidate("```\r\n[1,2]\r\n```")).toBe("[1,2]");
		expect(extractJsonCandidate('```json  \n\n{"a":1}\n```')).toBe('{"a":1}');
		expect(extractJsonCandidate('text {"a":{"b":"}"}} tail')).toBe('{"a":{"b":"}"}}');
	});

	it("is linear on an unterminated fence followed by many newlines and tabs", () => {
		const text = `\`\`\`\n${"\n\t".repeat(60_000)}`;
		expect(timed(() => extractJsonCandidate(text))).toBeLessThan(TIME_BUDGET_MS);
	});
});

describe("substituteArgs defaults (#7)", () => {
	function original(content: string, args: string[]): string {
		const allArgs = args.join(" ");
		return content.replace(
			/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
			(_match, defaultTarget, defaultValue, sliceStart, sliceLength, simple) => {
				if (defaultTarget) {
					const value =
						defaultTarget === "@" || defaultTarget === "ARGUMENTS"
							? allArgs
							: args[parseInt(defaultTarget, 10) - 1];
					return value ? value : defaultValue;
				}
				if (sliceStart) {
					let start = parseInt(sliceStart, 10) - 1;
					if (start < 0) start = 0;
					if (sliceLength) return args.slice(start, start + parseInt(sliceLength, 10)).join(" ");
					return args.slice(start).join(" ");
				}
				if (simple === "ARGUMENTS" || simple === "@") return allArgs;
				return args[parseInt(simple, 10) - 1] ?? "";
			},
		);
	}

	it("matches the original single-pass regex on fuzz input", () => {
		const pieces = ["$", "{", "}", ":", "-", "@", "1", "2", "ARGUMENTS", "a", " ", "\n", "${", ":-", "${@:"];
		const argSets = [[], ["x"], ["x", "y z", ""]];
		for (const sample of fuzz(pieces, 4000, 12, 7)) {
			for (const args of argSets) {
				expect(substituteArgs(sample, args), JSON.stringify([sample, args])).toBe(original(sample, args));
			}
		}
	});

	it("keeps multi-line defaults exactly as before", () => {
		expect(substituteArgs(`a \${1:-two\nlines} b`, [])).toBe("a two\nlines b");
	});

	it("keeps single-line defaults and positional forms", () => {
		expect(substituteArgs(`List \${1:-7} steps \${2:-brief} $@ \${@:2}`, ["a", "b", "c"])).toBe(
			"List a steps b a b c b c",
		);
		expect(substituteArgs(`\${1:-seven steps}`, [])).toBe("seven steps");
		expect(substituteArgs(`\${ARGUMENTS:-none}`, [])).toBe("none");
	});

	it("is linear on many unterminated default expansions", () => {
		const content = `\${1:-`.repeat(20_000);
		expect(timed(() => substituteArgs(content, []))).toBeLessThan(TIME_BUDGET_MS);
	});
});

describe("parseNpmSpec (#8)", () => {
	let tempDir: string;
	let packageManager: DefaultPackageManager;

	beforeAll(() => {
		tempDir = join(tmpdir(), `pm-npm-spec-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(tempDir, "agent"), { recursive: true });
		packageManager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir: join(tempDir, "agent"),
			settingsManager: SettingsManager.inMemory({}),
		});
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function parse(spec: string): { name: string; version?: string } {
		return (packageManager as any).parseNpmSpec(spec);
	}

	function original(spec: string): { name: string; version?: string } {
		const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
		if (!match) return { name: spec };
		return { name: match[1] ?? spec, version: match[2] };
	}

	it("matches the original regex on fuzz input", () => {
		for (const sample of fuzz(["@", "/", "a", "1", ".", "-", "?", "\n"], 5000, 10, 8)) {
			const actual = parse(sample);
			const expected = original(sample);
			expect(actual.name, JSON.stringify(sample)).toBe(expected.name);
			expect(actual.version, JSON.stringify(sample)).toBe(expected.version);
		}
	});

	it("keeps the documented shapes", () => {
		expect(parse("pkg")).toEqual({ name: "pkg" });
		expect(parse("pkg@1.2.3")).toEqual({ name: "pkg", version: "1.2.3" });
		expect(parse("@scope/pkg")).toEqual({ name: "@scope/pkg" });
		expect(parse("@scope/pkg@^2")).toEqual({ name: "@scope/pkg", version: "^2" });
		expect(parse("pkg@")).toEqual({ name: "pkg@" });
	});

	it("is linear on many slashes without a version", () => {
		const spec = `${"?/".repeat(50_000)}@`;
		expect(timed(() => parse(spec))).toBeLessThan(TIME_BUDGET_MS);
	});
});
