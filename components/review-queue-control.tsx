"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CalendarClockIcon } from "lucide-react";
import { usePopoverDismiss } from "@/components/popover-dismiss";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
	dueLabel,
	localIsoDay,
	parseReviewQueue,
	reteachStart,
	REVIEW_SESSION_LIMIT,
	reviewPracticeStart,
	type ReviewItem,
	type ReviewQueue,
	type ReviewStart,
} from "@/src/core";

/**
 * THE DUE-FOR-PRACTICE QUEUE (M20): Home's review pill and its popover.
 * The server works the dates out (GET /api/practice/due replays the
 * practice sessions through FSRS); this control shows them and starts
 * sessions from them. It stays hidden until something has been practiced.
 */

/** How many upcoming reviews the popover lists. */
export const UPCOMING_SHOWN = 5;

/** GET /api/practice/due, parsed. Null when the read fails. */
export async function fetchReviewQueue(fetchLike: typeof fetch = fetch): Promise<ReviewQueue | null> {
	try {
		const res = await fetchLike("/api/practice/due", { cache: "no-store" });
		return res.ok ? parseReviewQueue(await res.json()) : null;
	} catch {
		return null;
	}
}

/** The pill's words: what's due, else what keeps slipping, else when the
 *  next review is. Null when nothing has been practiced yet. */
export function reviewChipLabel(queue: ReviewQueue, now: Date): string | null {
	if (queue.due.length > 0) return `${queue.due.length} due`;
	if (queue.slipping.length > 0) return `${queue.slipping.length} slipping`;
	const next = queue.upcoming[0];
	return next ? `Next review ${dueLabel(next.due, now)}` : null;
}

function ItemRow({ item, testId, children }: { item: ReviewItem; testId: string; children: ReactNode }) {
	return (
		<li data-testid={testId} className="flex items-start gap-2 rounded-md px-1.5 py-1">
			<span className="min-w-0 flex-1">
				<span className="block truncate text-foreground">{item.name}</span>
				<span className="block truncate text-[11px] text-muted-foreground">{item.statement}</span>
			</span>
			{children}
		</li>
	);
}

function DueTime({ item, now }: { item: ReviewItem; now: Date }) {
	return (
		<time
			dateTime={item.due}
			title={localIsoDay(item.due)}
			className="shrink-0 pt-px text-[11px] tabular-nums text-muted-foreground"
		>
			{dueLabel(item.due, now)}
		</time>
	);
}

/** The popover's body: pure props in, markup out (the SSR tests render it). */
export function ReviewQueuePanel({
	queue,
	now,
	busy,
	onStart,
}: {
	queue: ReviewQueue;
	now: Date;
	busy: boolean;
	onStart: (start: ReviewStart) => void;
}) {
	const upcoming = queue.upcoming.slice(0, UPCOMING_SHOWN);
	return (
		<div role="dialog" aria-label="Practice reviews" data-testid="review-panel" className="flex flex-col gap-3 text-xs">
			{queue.due.length > 0 ? (
				<section aria-label="Due for practice" className="flex flex-col gap-1">
					<div className="flex items-center justify-between gap-2">
						<h3 className="font-medium">Due for practice</h3>
						<Button
							type="button"
							size="sm"
							disabled={busy}
							onClick={() => onStart(reviewPracticeStart(queue.due))}
							data-testid="review-practice"
						>
							Practice these
						</Button>
					</div>
					<ul className="max-h-56 overflow-y-auto pr-1">
						{queue.due.map((item) => (
							<ItemRow key={item.id} item={item} testId="review-due-item">
								<DueTime item={item} now={now} />
							</ItemRow>
						))}
					</ul>
					{queue.due.length > REVIEW_SESSION_LIMIT ? (
						<p className="text-[11px] leading-snug text-muted-foreground">
							Practice these takes the {REVIEW_SESSION_LIMIT} most overdue.
						</p>
					) : null}
				</section>
			) : null}
			{queue.slipping.length > 0 ? (
				<section aria-label="Keeps slipping" className="flex flex-col gap-1">
					<h3 className="font-medium">Keeps slipping</h3>
					<p className="text-[11px] leading-snug text-muted-foreground">
						Missed in practice again and again. More drilling won&apos;t fix it; a fresh explanation might.
					</p>
					<ul className="max-h-40 overflow-y-auto pr-1">
						{queue.slipping.map((item) => (
							<ItemRow key={item.id} item={item} testId="review-slipping-item">
								<span className="shrink-0 pt-px text-[11px] tabular-nums text-muted-foreground">
									Missed {item.misses} times
								</span>
								<Button
									type="button"
									size="xs"
									variant="outline"
									disabled={busy}
									aria-label={`Teach again: ${item.name}`}
									onClick={() => onStart(reteachStart(item))}
									data-testid="review-reteach"
								>
									Teach again
								</Button>
							</ItemRow>
						))}
					</ul>
				</section>
			) : null}
			{upcoming.length > 0 ? (
				<section aria-label="Coming up" className="flex flex-col gap-1">
					<h3 className="font-medium">Coming up</h3>
					<ul>
						{upcoming.map((item) => (
							<ItemRow key={item.id} item={item} testId="review-upcoming-item">
								<DueTime item={item} now={now} />
							</ItemRow>
						))}
					</ul>
				</section>
			) : null}
			<p className="text-[11px] leading-snug text-muted-foreground">
				Worked out on this computer from your practice results with FSRS, a spaced-repetition scheduler.
			</p>
		</div>
	);
}

// ─── The pill ────────────────────────────────────────────────────────────

/** The composer row's review pill and its popover. Hidden while the queue is empty. */
export function ReviewQueueControl({ busy, onStart }: { busy: boolean; onStart: (start: ReviewStart) => void }) {
	const [queue, setQueue] = useState<ReviewQueue | null>(null);
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	// Only the newest read lands: an older, slower one never overwrites it.
	const latest = useRef(0);
	const refresh = useCallback(async () => {
		const ticket = ++latest.current;
		const next = await fetchReviewQueue();
		if (next && ticket === latest.current) setQueue(next);
	}, []);
	useEffect(() => {
		void refresh();
	}, [refresh]);
	const close = useCallback(() => {
		// Focus returns to the pill only when it was inside the panel; a
		// click elsewhere keeps its own focus.
		if (rootRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
		setOpen(false);
	}, []);
	usePopoverDismiss(rootRef, open, close);
	useEffect(() => {
		if (open) rootRef.current?.querySelector<HTMLElement>("[data-testid='review-panel'] button")?.focus();
	}, [open]);

	const now = new Date();
	const label = queue ? reviewChipLabel(queue, now) : null;
	if (!queue || !label) return null;
	const due = queue.due.length > 0;
	return (
		<div ref={rootRef} className="relative flex min-w-0 items-center">
			<button
				ref={triggerRef}
				type="button"
				aria-expanded={open}
				aria-haspopup="dialog"
				aria-label={`Practice reviews: ${label}`}
				onClick={() => {
					if (!open) void refresh();
					setOpen((o) => !o);
				}}
				data-testid="review-chip"
				className={cn(
					"flex min-w-0 max-w-[18rem] cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 font-ui text-xs transition-colors",
					due
						? "border-border bg-card text-foreground hover:bg-accent"
						: "border-dashed border-border/80 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
				)}
			>
				<CalendarClockIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="truncate">{label}</span>
			</button>
			{open && (
				<div className="absolute bottom-full left-0 z-20 mb-2 max-h-[min(36rem,calc(100dvh-12rem))] w-[26rem] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border bg-card/95 p-2.5 shadow-lg backdrop-blur">
					<ReviewQueuePanel
						queue={queue}
						now={now}
						busy={busy}
						onStart={(start) => {
							setOpen(false);
							onStart(start);
						}}
					/>
				</div>
			)}
		</div>
	);
}
