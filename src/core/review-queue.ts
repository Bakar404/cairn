/**
 * The due-for-practice queue's shape (M20): what GET /api/practice/due
 * answers, and the pure helpers Home's panel renders it with.
 *
 * Browser-safe. The replay that works the dates out is
 * core/review-schedule.ts, which only the server imports: ts-fsrs patches
 * Date.prototype when it loads, so it stays out of the client bundle.
 */
import type { GraphContextPick } from "./native-messages.ts";

/** How one counted retrieval went, on FSRS's scale. Easy is never given:
 *  a tutor's record can't tell an easy retrieval from a good one. */
export type ReviewRating = "again" | "hard" | "good";

/** One practiced proposition and when it is due again. */
export interface ReviewItem {
	id: string;
	name: string;
	statement: string;
	/** When FSRS schedules the next retrieval (ISO). It is due all of that
	 *  local day: FSRS keeps the practice's time of day, the queue counts days. */
	due: string;
	/** The latest counted retrieval (ISO). */
	lastReviewed: string;
	/** Counted retrievals: one per practice session at most. */
	reviews: number;
	/** Counted retrievals rated "again". */
	misses: number;
	lastRating: ReviewRating;
}

export interface ReviewQueue {
	/** When the queue was worked out (ISO). */
	at: string;
	/** Due today or overdue, most overdue first. */
	due: ReviewItem[];
	/** Not due yet, soonest first. */
	upcoming: ReviewItem[];
	/** Leeches: missed again and again, with no teach session since the
	 *  latest miss. Teaching repairs them; more drilling would not. */
	slipping: ReviewItem[];
}

/** The most propositions one review session takes, the most overdue first. */
export const REVIEW_SESSION_LIMIT = 10;

const DAY_MS = 86_400_000;

/** Whole local calendar days from `now` to `iso`: 0 today, 1 tomorrow, -2 two days ago. */
export function localDaysUntil(iso: string, now: Date): number {
	const date = new Date(iso);
	const target = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
	const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
	return Math.round((target - today) / DAY_MS);
}

/** Whether a review dated `iso` is due on `now`'s local day or before it. */
export function isDueBy(iso: string, now: Date): boolean {
	return localDaysUntil(iso, now) <= 0;
}

/** `iso`'s local day as YYYY-MM-DD, the app's date format (sidebar timeAgo). */
export function localIsoDay(iso: string): string {
	const date = new Date(iso);
	const mm = String(date.getMonth() + 1).padStart(2, "0");
	const dd = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${mm}-${dd}`;
}

/** A due date in words: "due today", "3 days overdue", "tomorrow",
 *  "in 4 days", and the date itself from a week out. */
export function dueLabel(iso: string, now: Date): string {
	const days = localDaysUntil(iso, now);
	if (days < 0) return days === -1 ? "1 day overdue" : `${-days} days overdue`;
	if (days === 0) return "due today";
	if (days === 1) return "tomorrow";
	if (days < 7) return `in ${days} days`;
	return localIsoDay(iso);
}

/** What one start from the queue sends to POST /api/chats, plus the
 *  learner's first message. The picks ride the creation as the session's
 *  map context, so the agent knows exactly which propositions are meant. */
export interface ReviewStart {
	kind: "teach" | "practice";
	title: string;
	prompt: string;
	picks: GraphContextPick[];
}

const pickOf = (item: ReviewItem): GraphContextPick => ({ id: item.id, name: item.name, statement: item.statement });

/** "Practice these": a practice session on the most overdue propositions. */
export function reviewPracticeStart(due: readonly ReviewItem[]): ReviewStart {
	const items = due.slice(0, REVIEW_SESSION_LIMIT);
	const first = items[0]?.name ?? "practice";
	return {
		kind: "practice",
		title: items.length > 1 ? `Review: ${first} and ${items.length - 1} more` : `Review: ${first}`,
		prompt: "Give me practice problems on what's due for review.",
		picks: items.map(pickOf),
	};
}

/** "Teach again": a teach session on one proposition that keeps slipping. */
export function reteachStart(item: ReviewItem): ReviewStart {
	return {
		kind: "teach",
		title: `Teach again: ${item.name}`,
		prompt: `I keep missing "${item.name}" in practice. Teach it to me again, a different way this time.`,
		picks: [pickOf(item)],
	};
}

// ─── The client's parse of GET /api/practice/due ─────────────────────────

const RATINGS: ReadonlySet<string> = new Set<ReviewRating>(["again", "hard", "good"]);

function parseItem(raw: unknown): ReviewItem | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== "string" || typeof r.name !== "string" || typeof r.statement !== "string") return null;
	if (typeof r.due !== "string" || Number.isNaN(Date.parse(r.due))) return null;
	if (typeof r.lastReviewed !== "string" || Number.isNaN(Date.parse(r.lastReviewed))) return null;
	if (typeof r.reviews !== "number" || typeof r.misses !== "number") return null;
	if (typeof r.lastRating !== "string" || !RATINGS.has(r.lastRating)) return null;
	return {
		id: r.id,
		name: r.name,
		statement: r.statement,
		due: r.due,
		lastReviewed: r.lastReviewed,
		reviews: r.reviews,
		misses: r.misses,
		lastRating: r.lastRating as ReviewRating,
	};
}

function parseItems(raw: unknown): ReviewItem[] | null {
	if (!Array.isArray(raw)) return null;
	const items = raw.map(parseItem);
	return items.every((item): item is ReviewItem => item !== null) ? items : null;
}

/** The route's answer, or null when it isn't a queue this build can read. */
export function parseReviewQueue(raw: unknown): ReviewQueue | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.at !== "string") return null;
	const due = parseItems(r.due);
	const upcoming = parseItems(r.upcoming);
	const slipping = parseItems(r.slipping);
	if (!due || !upcoming || !slipping) return null;
	return { at: r.at, due, upcoming, slipping };
}
