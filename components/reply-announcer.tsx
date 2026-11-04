"use client";
/**
 * Reply announcements (accessibility mode, M27). The transcript is a
 * role="log" region, so a screen reader hears what's added to it. It
 * doesn't hear the teacher start or finish a reply, which is all a
 * spinner shows. This always-mounted polite status region says it:
 * "Cairn is replying…" when a reply starts and "Reply finished" when it
 * ends. With "Announce tool steps" on, a tool step that is still running
 * after five seconds is named too, at most once every fifteen.
 *
 * The region is mounted empty, so assistive tech has registered it before
 * its first change, and it sits outside the log so nothing reads it twice.
 * Each line is cleared after a few seconds, so the next reply's identical
 * line is a fresh change.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccessibility } from "@/components/settings/accessibility";

export const REPLY_STARTED = "Cairn is replying…";
export const REPLY_FINISHED = "Reply finished";
/** A reply has to stay busy this long to be announced, so a flicker isn't. */
export const START_DELAY_MS = 100;
/** A busy dip shorter than this (one reply handing off to its owed
 *  continuation) stays one reply. */
export const FINISH_GRACE_MS = 1000;
/** A spoken line is cleared after this. */
export const CLEAR_MS = 7000;
/** A tool step is named once it has been running this long… */
export const STEP_DELAY_MS = 5000;
/** …and no sooner than this after the last named step. */
export const STEP_INTERVAL_MS = 15000;

export interface AnnouncedStep {
	/** The tool call id: two calls with the same label are two steps. */
	id: string;
	label: string;
}

export function ReplyAnnouncer({ busy, step }: { busy: boolean; step: AnnouncedStep | null }) {
	const announceSteps = useAccessibility().accessibility.announceToolSteps;
	const [line, setLine] = useState("");
	const clearTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const startTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const finishTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const open = useRef(false);
	const lastStepId = useRef<string | undefined>(undefined);
	const lastStepAt = useRef(Number.NEGATIVE_INFINITY);

	const say = useCallback((text: string) => {
		setLine(text);
		clearTimeout(clearTimer.current);
		clearTimer.current = setTimeout(() => setLine(""), CLEAR_MS);
	}, []);

	// The timers outlive busy flips on purpose, so this effect has no cleanup:
	// a start still pending when busy drops is cancelled unspoken, and a
	// finish still pending when busy returns is cancelled, keeping one reply.
	useEffect(() => {
		if (busy) {
			clearTimeout(finishTimer.current);
			finishTimer.current = undefined;
			if (!open.current && startTimer.current === undefined) {
				startTimer.current = setTimeout(() => {
					startTimer.current = undefined;
					open.current = true;
					say(REPLY_STARTED);
				}, START_DELAY_MS);
			}
		} else if (startTimer.current !== undefined) {
			clearTimeout(startTimer.current);
			startTimer.current = undefined;
		} else if (open.current && finishTimer.current === undefined) {
			finishTimer.current = setTimeout(() => {
				finishTimer.current = undefined;
				open.current = false;
				say(REPLY_FINISHED);
			}, FINISH_GRACE_MS);
		}
	}, [busy, say]);

	// Resetting the refs lets StrictMode's remount schedule the start again.
	useEffect(
		() => () => {
			clearTimeout(startTimer.current);
			clearTimeout(finishTimer.current);
			clearTimeout(clearTimer.current);
			startTimer.current = finishTimer.current = clearTimer.current = undefined;
		},
		[],
	);

	const stepId = step?.id;
	const stepLabel = step?.label;
	useEffect(() => {
		if (!announceSteps || !busy || stepId === undefined || stepLabel === undefined) return;
		if (stepId === lastStepId.current) return;
		const wait = Math.max(STEP_DELAY_MS, lastStepAt.current + STEP_INTERVAL_MS - Date.now());
		const timer = setTimeout(() => {
			lastStepId.current = stepId;
			lastStepAt.current = Date.now();
			say(stepLabel);
		}, wait);
		return () => clearTimeout(timer);
	}, [announceSteps, busy, stepId, stepLabel, say]);

	return (
		<div role="status" aria-live="polite" className="sr-only" data-testid="reply-announcer">
			{line}
		</div>
	);
}
