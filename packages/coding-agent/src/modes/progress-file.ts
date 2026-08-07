/**
 * Progress file support for print mode (`pi -p --progress-file progress.jsonl`).
 *
 * Piri A2A worker Phase 0 (jinwon-int/a2a-nexus#1745 item 2): long-running
 * worker tasks look identical to stuck ones from the outside because print
 * mode is silent until the final answer. Wrappers (docker runner, broker
 * poller) can only watch process liveness. With --progress-file the harness
 * appends compact JSONL progress events — turn/tool/retry boundaries with
 * timestamps — so an outer watcher can use file mtime/content to distinguish
 * "working" from "stuck" and to attribute stalls.
 *
 * Projections are deliberately content-free: no message text, tool args, or
 * results are written, only event types and coarse metadata (tool names,
 * attempt counters). High-frequency delta streams (message_update,
 * tool_execution_update, bash_execution_update, queue_update) are skipped.
 */

import { createWriteStream, type WriteStream } from "node:fs";
import type { AgentSessionEvent } from "../core/agent-session.ts";

/** Compact, content-free progress projection of a session event. */
export function projectProgressEvent(event: AgentSessionEvent): Record<string, unknown> | undefined {
	const ts = new Date().toISOString();
	switch (event.type) {
		case "agent_start":
		case "agent_end":
		case "agent_settled":
		case "turn_start":
			return { ts, type: event.type };
		case "turn_end":
			return { ts, type: event.type, toolResults: event.toolResults.length };
		case "message_start":
		case "message_end":
			return { ts, type: event.type, role: event.message.role };
		case "tool_execution_start":
			return { ts, type: event.type, tool: event.toolName };
		case "tool_execution_end":
			return { ts, type: event.type, tool: event.toolName, isError: event.isError };
		case "auto_retry_start":
			return { ts, type: event.type, attempt: event.attempt, maxAttempts: event.maxAttempts };
		case "auto_retry_end":
			return { ts, type: event.type, success: event.success, attempt: event.attempt };
		case "compaction_start":
			return { ts, type: event.type, reason: event.reason };
		case "compaction_end":
			return { ts, type: event.type };
		default:
			// message_update / tool_execution_update / bash_execution_update /
			// queue_update / session_info_changed / ... — too chatty or contentful.
			return undefined;
	}
}

export interface ProgressFileWriter {
	/** Project and append one event; no-ops for skipped event types. */
	write(event: AgentSessionEvent): void;
	/** Append an out-of-band marker (e.g. schema retry) not visible via session events. */
	mark(marker: string, detail?: Record<string, unknown>): void;
	/** Flush and close the underlying stream. */
	close(): Promise<void>;
}

/**
 * Open a progress file for appending. Throws on open failure — callers
 * translate that into a usage error (exit code 2) so a silently missing
 * heartbeat surface can never pass as a healthy run.
 */
export function openProgressFile(path: string): Promise<ProgressFileWriter> {
	const stream: WriteStream = createWriteStream(path, { flags: "a" });
	return new Promise((resolve, reject) => {
		stream.once("open", () => {
			resolve({
				write: (event) => {
					const projected = projectProgressEvent(event);
					if (projected) stream.write(`${JSON.stringify(projected)}\n`);
				},
				mark: (marker, detail) => {
					stream.write(`${JSON.stringify({ ts: new Date().toISOString(), type: "marker", marker, ...detail })}\n`);
				},
				close: () =>
					new Promise<void>((resolveClose, rejectClose) => {
						stream.end((err: Error | null | undefined) => (err ? rejectClose(err) : resolveClose()));
					}),
			});
		});
		stream.once("error", reject);
	});
}
