import { describe, expect, it } from "vitest";
import { buildSchemaFeedback, compileOutputSchema, extractJsonCandidate, repairRootAdditionalProperties } from "../src/modes/output-schema.ts";

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

describe("repairRootAdditionalProperties (#1815 remove-only normalization)", () => {
	const closedSchema = {
		type: "object",
		required: ["status"],
		additionalProperties: false,
		properties: { status: { type: "string" }, summary: { type: "string" } },
	} as const;

	it("drops root keys the closed schema does not allow", () => {
		const repaired = repairRootAdditionalProperties(
			closedSchema as never,
			{ status: "done", summary: "ok", metadata: { long: "object" }, confidence: 0.9 },
		);
		expect(repaired?.value).toEqual({ status: "done", summary: "ok" });
		expect(repaired?.droppedKeys).toEqual(["metadata", "confidence"]);
	});

	it("keeps nested content untouched — repair is root-only", () => {
		const repaired = repairRootAdditionalProperties(
			closedSchema as never,
			{ status: "done", extra: { nested: { deep: true } } },
		);
		expect(repaired?.value).toEqual({ status: "done" });
	});

	it("returns undefined when nothing needs dropping", () => {
		expect(repairRootAdditionalProperties(closedSchema as never, { status: "done" })).toBeUndefined();
	});

	it("returns undefined for non-object roots", () => {
		expect(repairRootAdditionalProperties(closedSchema as never, "text")).toBeUndefined();
		expect(repairRootAdditionalProperties(closedSchema as never, [1, 2])).toBeUndefined();
		expect(repairRootAdditionalProperties(closedSchema as never, null)).toBeUndefined();
	});

	it("never repairs an open schema (extras allowed means content is contractual)", () => {
		const openSchema = { type: "object", properties: { status: { type: "string" } } };
		expect(repairRootAdditionalProperties(openSchema as never, { status: "done", note: "keep me" })).toBeUndefined();
	});

	it("never repairs a schema without declared properties", () => {
		const emptySchema = { type: "object", additionalProperties: false };
		expect(repairRootAdditionalProperties(emptySchema as never, { a: 1 })).toBeUndefined();
	});
});
