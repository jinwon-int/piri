/**
 * Output schema support for print mode (`pi -p --output-schema schema.json`).
 *
 * Piri A2A worker Phase 0 (jinwon-int/a2a-nexus#1745): worker tasks must
 * return a strict JSON contract (status/summary/findings/...), and wrapping
 * harnesses can only prompt-and-repair around free text. Because piri is
 * modifiable, the contract lives inside the harness instead: the final
 * assistant message is validated against a JSON Schema and, on violation,
 * the model is re-prompted with the validator errors until the output
 * satisfies the schema or the attempt budget runs out.
 */

import { readFile } from "node:fs/promises";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";

/** Maximum validation errors surfaced to the model per retry. */
const MAX_FEEDBACK_ERRORS = 10;

export interface OutputSchemaValidator {
	/** Returns true when the value satisfies the schema. */
	check(value: unknown): boolean;
	/** Human-readable "path: message" list, capped at MAX_FEEDBACK_ERRORS. */
	errors(value: unknown): string[];
}

/**
 * Load a JSON Schema from disk. Throws on unreadable file or invalid JSON —
 * callers translate that into a usage error (exit code 2).
 */
export async function loadOutputSchema(path: string): Promise<TSchema> {
	const raw = await readFile(path, "utf8");
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("output schema must be a JSON object");
	}
	return parsed as TSchema;
}

/**
 * Compile a JSON Schema into a reusable validator. The schema is treated as
 * the TypeBox-compatible JSON Schema subset (type/properties/required/items/
 * enum/additionalProperties/...); unsupported constructs throw here, not at
 * validation time.
 */
export function compileOutputSchema(schema: TSchema): OutputSchemaValidator {
	const validator = Compile(schema);
	return {
		check: (value) => validator.Check(value),
		errors: (value) =>
			validator
				.Errors(value)
				.slice(0, MAX_FEEDBACK_ERRORS)
				.map((error) => {
					const path = "path" in error && typeof error.path === "string" ? error.path : "";
					const message = "message" in error ? String(error.message) : "schema violation";
					return `${path || "/"}: ${message}`;
				}),
	};
}

/**
 * Extract the first complete JSON object/array from free text.
 *
 * Models habitually wrap payloads in ```json fences or pad them with
 * commentary; brace matching finds the first balanced {...} or [...] without
 * being fooled by braces inside string literals. Returns undefined when no
 * balanced candidate exists.
 */
export function extractJsonCandidate(text: string): string | undefined {
	const fenced = text.match(/```(?:json)?\s*\r?\n([\s\S]*?)```/);
	const haystack = fenced ? fenced[1] : text;
	const start = haystack.search(/[{[]/);
	if (start === -1) return undefined;
	const open = haystack[start];
	const close = open === "{" ? "}" : "]";
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < haystack.length; i++) {
		const ch = haystack[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === open) depth++;
		else if (ch === close) {
			depth--;
			if (depth === 0) return haystack.slice(start, i + 1);
		}
	}
	return undefined;
}

/**
 * Build the re-prompt sent after a schema violation. Carries validator
 * errors only — never the operator's prompt or prior task content.
 */
export function buildSchemaFeedback(errors: string[]): string {
	const listed = errors.length > 0 ? errors : ["output was not valid JSON"];
	return [
		"Your previous response did not satisfy the required output schema.",
		"Validation errors:",
		...listed.map((line) => `- ${line}`),
		"",
		"Respond with ONLY the corrected JSON value — no markdown fences, no commentary.",
	].join("\n");
}
