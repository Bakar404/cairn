"use client";

import { createContext } from "react";
import { danglingQuestionOf, endsInDismissal, type JobRecord, type LhMessage } from "@/src/core";

/**
 * Background-job observability channel (contracts.ts "THE ASYNC PROTOCOL" §4).
 *
 * ONE central fetch (in Chat) reads GET /api/jobs?chatId=… and publishes
 * the list here — on mount, per jobs-changed announcement (the store emits
 * post-write), and on channel resync (push-architecture S4, 2026-10-02);
 * every job surface consumes it — the transcript dispatch cards (the ack
 * box with live status) and the sub-agents sidebar panel. Cards used to
 * each run their own poller on input-available parts; under the
 * ack-protocol the tool part resolves immediately, so the fetch moved
 * to the composition root and the cards became pure renderers of this data.
 */
export const JobsContext = createContext<JobRecord[]>([]);

const NONE: ReadonlySet<string> = new Set();

/**
 * Finished jobs whose result the LEARNER is holding (pure). The wake
 * pipeline (src/server/jobs.ts) never steers a result past an unanswered
 * question or a dismissal tail: the steer waits for the answer or the
 * next send, so the steer card that shows the artifact doesn't exist yet.
 * Until it lands, the dispatch card shows the artifact itself
 * (DispatchCard renderHeld). Without a question or dismissal nothing is
 * held: the steer follows within the pump's grace window, and an early
 * render would only flash.
 */
export function heldResultJobIds(jobs: readonly JobRecord[], messages: readonly LhMessage[]): ReadonlySet<string> {
	if (jobs.length === 0) return NONE;
	if (danglingQuestionOf(messages) === null && !endsInDismissal(messages)) return NONE;
	const held = new Set<string>();
	for (const job of jobs) {
		if (job.status !== "done" || job.result === undefined) continue;
		if (job.delivery?.kind !== "result" || job.delivery.status !== "pending") continue;
		const steerId = `steer_${job.id}`;
		if (messages.some((m) => m.id === steerId)) continue;
		held.add(job.id);
	}
	return held.size === 0 ? NONE : held;
}

/** heldResultJobIds for the open chat, published next to JobsContext. */
export const HeldResultsContext = createContext<ReadonlySet<string>>(NONE);
