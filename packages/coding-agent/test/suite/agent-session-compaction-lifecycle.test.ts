import { type AssistantMessage, createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompactionEntry } from "../../src/core/session-manager.ts";
import { getLatestCompactionEntry } from "../../src/core/session-manager.ts";
import type { ResourceLoader } from "../../src/index.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

type SessionWithCompactionInternals = {
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function seedCompactableSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	const assistant = {
		...fauxAssistantMessage("assistant response to compact", { timestamp: now - 500 }),
		usage: createUsage(100),
	};
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function useSummaryStreamFn(harness: Harness, summary: string): void {
	harness.session.agent.streamFunction = (model) => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				...fauxAssistantMessage(summary),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createUsage(10),
			};
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
}

function latestCompaction(harness: Harness): CompactionEntry {
	const entry = getLatestCompactionEntry(harness.sessionManager.getEntries());
	if (!entry) throw new Error("expected a compaction entry");
	return entry;
}

describe("AgentSession compaction lifecycle (piri#2)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("emits compaction_start/end with body-free session and entry identifiers (manual, default summary)", async () => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		seedCompactableSession(harness);
		useSummaryStreamFn(harness, "compacted summary");

		const result = await harness.session.compact();

		const starts = harness.eventsOfType("compaction_start");
		const ends = harness.eventsOfType("compaction_end");
		expect(starts).toHaveLength(1);
		expect(ends).toHaveLength(1);

		const start = starts[0]!;
		const end = ends[0]!;
		expect(start.reason).toBe("manual");
		expect(start.sessionId).toBe(harness.session.sessionId);
		expect(end.sessionId).toBe(harness.session.sessionId);

		const entry = latestCompaction(harness);
		expect(end.aborted).toBe(false);
		expect(end.compactionEntryId).toBe(entry.id);
		expect(end.firstKeptEntryId).toBe(entry.firstKeptEntryId);
		expect(end.firstKeptEntryId).toBe(result.firstKeptEntryId);

		// Ordering: start strictly before end.
		const startIndex = harness.events.indexOf(start);
		const endIndex = harness.events.indexOf(end);
		expect(startIndex).toBeGreaterThanOrEqual(0);
		expect(endIndex).toBeGreaterThan(startIndex);
	});

	it("emits the same identifiers on automatic threshold compaction", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		const internals = harness.session as unknown as SessionWithCompactionInternals;
		const continued = await internals._runAutoCompaction("threshold", false);
		expect(continued).toBe(false);

		const starts = harness.eventsOfType("compaction_start");
		const ends = harness.eventsOfType("compaction_end");
		expect(starts).toHaveLength(1);
		expect(ends).toHaveLength(1);
		expect(starts[0]!.reason).toBe("threshold");
		expect(starts[0]!.sessionId).toBe(harness.session.sessionId);
		expect(ends[0]!.sessionId).toBe(harness.session.sessionId);

		const entry = latestCompaction(harness);
		expect(ends[0]!.compactionEntryId).toBe(entry.id);
		expect(ends[0]!.firstKeptEntryId).toBe(entry.firstKeptEntryId);
	});

	it("keeps identifiers body-free on aborted compaction (no entry ids)", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		const internals = harness.session as unknown as SessionWithCompactionInternals;
		await internals._runAutoCompaction("threshold", false);

		const ends = harness.eventsOfType("compaction_end");
		expect(ends).toHaveLength(1);
		expect(ends[0]!.aborted).toBe(true);
		expect(ends[0]!.sessionId).toBe(harness.session.sessionId);
		expect(ends[0]!.compactionEntryId).toBeUndefined();
		expect(ends[0]!.firstKeptEntryId).toBeUndefined();
	});

	it("applies a runtime-appended system prompt segment and preserves it across compaction", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "manual compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		harness.session.setRuntimeAppendSystemPrompt("MEMORY-SNAPSHOT-V1");
		expect(harness.session.systemPrompt).toContain("MEMORY-SNAPSHOT-V1");

		seedCompactableSession(harness);
		await harness.session.compact();

		// The appended context survives compaction and needs no manual re-append.
		expect(harness.session.systemPrompt).toContain("MEMORY-SNAPSHOT-V1");

		// Refresh: a host can replace the bounded context after compaction.
		harness.session.setRuntimeAppendSystemPrompt("MEMORY-SNAPSHOT-V2");
		expect(harness.session.systemPrompt).toContain("MEMORY-SNAPSHOT-V2");
		expect(harness.session.systemPrompt).not.toContain("MEMORY-SNAPSHOT-V1");

		// Clear: passing undefined removes the runtime segment.
		harness.session.setRuntimeAppendSystemPrompt(undefined);
		expect(harness.session.systemPrompt).not.toContain("MEMORY-SNAPSHOT-V2");
	});

	it("merges the runtime segment after loader-provided append-system-prompt segments", async () => {
		const resourceLoader: ResourceLoader = {
			...createTestResourceLoader(),
			getAppendSystemPrompt: () => ["LOADER-SEGMENT"],
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);

		harness.session.setRuntimeAppendSystemPrompt("RUNTIME-SEGMENT");
		const prompt = harness.session.systemPrompt;
		expect(prompt).toContain("LOADER-SEGMENT");
		expect(prompt).toContain("RUNTIME-SEGMENT");
		expect(prompt.indexOf("LOADER-SEGMENT")).toBeLessThan(prompt.indexOf("RUNTIME-SEGMENT"));

		// Clearing the runtime segment keeps the loader segment intact.
		harness.session.setRuntimeAppendSystemPrompt(undefined);
		expect(harness.session.systemPrompt).toContain("LOADER-SEGMENT");
		expect(harness.session.systemPrompt).not.toContain("RUNTIME-SEGMENT");
	});

	it("preserves provider/model selection across compaction", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "manual compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		const modelBefore = harness.session.model;
		expect(modelBefore).toBeDefined();

		seedCompactableSession(harness);
		await harness.session.compact();

		expect(harness.session.model?.provider).toBe(modelBefore?.provider);
		expect(harness.session.model?.id).toBe(modelBefore?.id);
	});
});
