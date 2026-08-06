import { describe, expect, it } from "vitest";
import { buildSchemaFeedback, compileOutputSchema, extractJsonCandidate } from "../src/modes/output-schema.ts";

describe("extractJsonCandidate", () => {
	it("returns a bare JSON object as-is", () => {
		expect(extractJsonCandidate('{"status":"done"}')).toBe('{"status":"done"}');
	});

	it("unwraps ```json fences", () => {
		expect(extractJsonCandidate('```json\n{"a":1}\n```')).toBe('{"a":1}');
	});

	it("skips prose around the payload", () => {
		expect(extractJsonCandidate('Here you go:\n{"a": {"b": 2}}\nHope that helps')).toBe('{"a": {"b": 2}}');
	});

	it("extracts arrays", () => {
		expect(extractJsonCandidate('[1, {"a": [2]}]')).toBe('[1, {"a": [2]}]');
	});

	it("ignores braces inside string literals", () => {
		expect(extractJsonCandidate('{"note": "use {curly} braces"}')).toBe('{"note": "use {curly} braces"}');
	});

	it("handles escaped quotes inside strings", () => {
		expect(extractJsonCandidate('{"q": "a\\"b"} trailing')).toBe('{"q": "a\\"b"}');
	});

	it("returns undefined without a balanced candidate", () => {
		expect(extractJsonCandidate("no json here")).toBeUndefined();
		expect(extractJsonCandidate('{"unterminated": ')).toBeUndefined();
	});
});

describe("compileOutputSchema", () => {
	const schema = {
		type: "object",
		required: ["status", "summary"],
		additionalProperties: false,
		properties: {
			status: { type: "string", enum: ["done", "blocked"] },
			summary: { type: "string" },
			confidence: { type: "string", enum: ["low", "medium", "high"] },
		},
	} as never;

	it("accepts a conforming value", () => {
		const validator = compileOutputSchema(schema);
		expect(validator.check({ status: "done", summary: "ok" })).toBe(true);
		expect(validator.errors({ status: "done", summary: "ok" })).toEqual([]);
	});

	it("rejects a missing required property with a named path", () => {
		const validator = compileOutputSchema(schema);
		const value = { summary: "ok" };
		expect(validator.check(value)).toBe(false);
		expect(validator.errors(value).join("\n")).toMatch(/status/);
	});

	it("rejects enum violations and additional properties", () => {
		const validator = compileOutputSchema(schema);
		expect(validator.check({ status: "maybe", summary: "ok" })).toBe(false);
		expect(validator.check({ status: "done", summary: "ok", extra: 1 })).toBe(false);
	});
});

describe("buildSchemaFeedback", () => {
	it("carries validator errors and demands bare JSON", () => {
		const feedback = buildSchemaFeedback(["/status: required property"]);
		expect(feedback).toContain("/status: required property");
		expect(feedback).toContain("ONLY the corrected JSON");
	});

	it("falls back to a generic error line", () => {
		expect(buildSchemaFeedback([])).toContain("not valid JSON");
	});
});
