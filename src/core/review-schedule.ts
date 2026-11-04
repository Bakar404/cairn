/**
 * THE REVIEW SCHEDULE (M20): when each practiced proposition is due again,
 * replayed on read from the practice sessions through FSRS (ts-fsrs). Code
 * works out every date and no model does. Nothing is written anywhere: the
 * graph contract is unchanged, and the practice agent still keeps no state
 * (its doctrine's "the session's own evidence is the only record" holds;
 * the schedule is a fold over those records).
 *
 * Pure, but deliberately NOT in the core barrel: ts-fsrs patches
 * Date.prototype when it loads, so the client bundle never imports it. The
 * server reads the chats (src/server/review-queue.ts); the browser gets
 * the ReviewQueue (core/review-queue.ts).
 */
import { createEmptyCard, fsrs, Rating, type Card, type FSRSParameters, type Grade } from "ts-fsrs";
import type { PracticeAssessment } from "./contracts/chat.ts";
import type { GraphNode } from "./contracts/graph.ts";
import {
	cleanToolCallIds,
	PRACTICE_CONCLUDE_TOOL,
	problemCallForConclude,
	type LhMessage,
} from "./native-messages.ts";
import { isDueBy, type ReviewItem, type ReviewQueue, type ReviewRating } from "./review-queue.ts";

/** The scheduler's settings. Fuzz is off so the dates are reproducible;
 *  short-term steps are off because practice happens in sessions, never
 *  minutes apart: even a miss is due again a day or more later. */
export const REVIEW_PARAMETERS: Readonly<Partial<FSRSParameters>> = {
	request_retention: 0.9,
	enable_fuzz: false,
	enable_short_term: false,
};

/** Misses that make a proposition a leech, when its latest retrieval missed too. */
export const LEECH_MISSES = 3;

const scheduler = fsrs({ ...REVIEW_PARAMETERS });

const GRADE: Readonly<Record<ReviewRating, Grade>> = {
	again: Rating.Again,
	hard: Rating.Hard,
	good: Rating.Good,
};

const RANK: Readonly<Record<ReviewRating, number>> = { again: 0, hard: 1, good: 2 };
const worse = (a: ReviewRating, b: ReviewRating): ReviewRating => (RANK[a] <= RANK[b] ? a : b);
const better = (a: ReviewRating, b: ReviewRating): ReviewRating => (RANK[a] >= RANK[b] ? a : b);

// ─── The rating map ──────────────────────────────────────────────────────

/** What a conclude call recorded (its arguments, unvalidated). */
export interface ConcludeFacts {
	outcome?: unknown;
	rung?: unknown;
	missClass?: unknown;
}

/** The hint ladder (practice doctrine §VI): R0–R1 means the problem was
 *  about right, R2 narrowed the candidates, and from R3 on the retrieval
 *  itself was given away. */
function rungRating(rung: unknown, hinted: boolean): ReviewRating {
	switch (rung) {
		case "R0":
		case "R1":
			return "good";
		case "R2":
			return "hard";
		case "R3":
		case "R4":
		case "R5":
			return "again";
		default:
			// No rung recorded: a hinted solve with hints of unknown depth.
			return hinted ? "hard" : "good";
	}
}

/**
 * One retrieval's rating. Solved with no hint, or at R0–R1, is Good; R2 is
 * Hard; R3–R5 is Again; moved on or surrendered is Again. When the answer
 * check (M24) disagrees with a credited outcome the rating drops, to Hard
 * for a partial answer and to Again for a wrong or missing one; the check
 * never raises a rating. A careless miss is a slip, not a gap: never worse
 * than Hard. Null when the retrieval doesn't count: a dismissed problem,
 * or an outcome this build doesn't know.
 */
export function reviewRating(
	facts: ConcludeFacts,
	check?: Pick<PracticeAssessment, "agrees" | "judgment">,
): ReviewRating | null {
	let rating: ReviewRating;
	switch (facts.outcome) {
		case "solved":
		case "solvedWithHints":
			rating = rungRating(facts.rung, facts.outcome === "solvedWithHints");
			if (check && !check.agrees) rating = worse(rating, check.judgment === "partial" ? "hard" : "again");
			break;
		case "movedOn":
		case "surrendered":
			rating = "again";
			break;
		default:
			return null;
	}
	return facts.missClass === "careless" ? better(rating, "hard") : rating;
}

// ─── Retrievals ──────────────────────────────────────────────────────────

/** One counted retrieval of one proposition. */
export interface Retrieval {
	/** The proposition's id: one of the problem's targets. */
	id: string;
	/** When the tutor concluded the problem (epoch ms). */
	at: number;
	rating: ReviewRating;
}

/** A practice session, as the replay reads it. */
export interface PracticeRecord {
	messages: readonly LhMessage[];
	assessments?: readonly PracticeAssessment[];
	/** The time for a conclude whose message carries none (ISO). */
	createdAt?: string;
}

function targetsOf(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return [...new Set(raw.filter((t): t is string => typeof t === "string" && t.length > 0))];
}

/**
 * The retrievals one practice session counts: per proposition, its first
 * counted attempt. A problem counts when it was posed cleanly with target
 * ids and concluded cleanly. Dismissed problems, errored calls, refused
 * poses and untagged problems never count, and a later problem on a
 * proposition this session already counted (a retest, a variant) adds
 * nothing: within a session, the first attempt is the retrieval.
 */
export function retrievalsOf(chat: PracticeRecord): Retrieval[] {
	const clean = cleanToolCallIds(chat.messages);
	const checks = new Map((chat.assessments ?? []).map((a) => [a.concludeCallId, a]));
	const fallback = Date.parse(chat.createdAt ?? "");
	const counted = new Set<string>();
	const retrievals: Retrieval[] = [];
	for (const m of chat.messages) {
		if (m.role !== "assistant") continue;
		for (const block of m.content) {
			if (block.type !== "toolCall" || block.name !== PRACTICE_CONCLUDE_TOOL || !clean.has(block.id)) continue;
			const rating = reviewRating((block.arguments ?? {}) as ConcludeFacts, checks.get(block.id));
			if (!rating) continue;
			const targets = targetsOf(problemCallForConclude(chat.messages, block.id)?.input?.target);
			const at = typeof m.timestamp === "number" && m.timestamp > 0 ? m.timestamp : fallback;
			if (targets.length === 0 || !Number.isFinite(at)) continue;
			for (const id of targets) {
				if (counted.has(id)) continue;
				counted.add(id);
				retrievals.push({ id, at, rating });
			}
		}
	}
	return retrievals;
}

// ─── The replay ──────────────────────────────────────────────────────────

/** One proposition after its retrievals. */
export interface ReviewState {
	card: Card;
	reviews: number;
	misses: number;
	lastRating: ReviewRating;
	/** Epoch ms of the latest retrieval, and of the latest miss. */
	lastReviewed: number;
	lastMiss: number | null;
}

/** Every proposition's FSRS card, its retrievals replayed oldest first. */
export function replayRetrievals(retrievals: readonly Retrieval[]): Map<string, ReviewState> {
	const states = new Map<string, ReviewState>();
	for (const r of [...retrievals].sort((a, b) => a.at - b.at)) {
		const previous = states.get(r.id);
		const when = new Date(r.at);
		const missed = r.rating === "again";
		states.set(r.id, {
			card: scheduler.next(previous?.card ?? createEmptyCard(when), when, GRADE[r.rating]).card,
			reviews: (previous?.reviews ?? 0) + 1,
			misses: (previous?.misses ?? 0) + (missed ? 1 : 0),
			lastRating: r.rating,
			lastReviewed: r.at,
			lastMiss: missed ? r.at : (previous?.lastMiss ?? null),
		});
	}
	return states;
}

/** A teach session, as the leech repair reads it. */
export interface TeachRecord {
	messages: readonly LhMessage[];
}

/** Per proposition, the newest time a teach session picked it and then
 *  ran: its map context named the proposition and the teacher answered. */
export function teachPicks(chats: Iterable<TeachRecord>): Map<string, number> {
	const latest = new Map<string, number>();
	for (const chat of chats) {
		chat.messages.forEach((m, i) => {
			if (m.role !== "custom" || m.customType !== "graph-context") return;
			const answered = chat.messages
				.slice(i + 1)
				.some((later) => later.role === "assistant" && later.stopReason !== "error");
			const picks = (m.details as { propositions?: unknown } | null)?.propositions;
			if (!answered || !Array.isArray(picks)) return;
			for (const pick of picks) {
				const id = (pick as { id?: unknown } | null)?.id;
				if (typeof id === "string" && m.timestamp > (latest.get(id) ?? -Infinity)) latest.set(id, m.timestamp);
			}
		});
	}
	return latest;
}

const isLeechCandidate = (s: ReviewState) => s.misses >= LEECH_MISSES && s.lastRating === "again" && s.lastMiss !== null;

export interface ReviewQueueInput {
	practice: Iterable<PracticeRecord>;
	/** The live graph: a retrieval of a deleted proposition is dropped. */
	nodes: readonly Pick<GraphNode, "id" | "name" | "statement">[];
	/** The teach sessions that could hold a pick made after `since`. Read
	 *  only when some proposition looks like a leech. */
	teachSince?: (since: Date) => Iterable<TeachRecord>;
	now: Date;
}

const byDue = (a: ReviewItem, b: ReviewItem) => Date.parse(a.due) - Date.parse(b.due) || a.name.localeCompare(b.name);

/**
 * The queue: every practiced proposition still in the graph, split into
 * due (today or overdue, most overdue first), upcoming (soonest first) and
 * slipping. A proposition slips, a leech, after LEECH_MISSES misses when
 * its latest retrieval missed and no teach session has picked it since.
 * A teach session that picks it repairs it: the item goes back to the FSRS
 * date its latest miss earned, so practice follows the reteach.
 */
export function buildReviewQueue(input: ReviewQueueInput): ReviewQueue {
	const live = new Map(input.nodes.map((n) => [n.id, n]));
	const retrievals = [...input.practice].flatMap(retrievalsOf).filter((r) => live.has(r.id));
	const states = replayRetrievals(retrievals);

	const candidates = [...states.values()].filter(isLeechCandidate);
	const repairs =
		candidates.length > 0 && input.teachSince
			? teachPicks(input.teachSince(new Date(Math.min(...candidates.map((s) => s.lastMiss!)))))
			: new Map<string, number>();

	const queue: ReviewQueue = { at: input.now.toISOString(), due: [], upcoming: [], slipping: [] };
	for (const [id, s] of states) {
		const node = live.get(id)!;
		const item: ReviewItem = {
			id,
			name: node.name,
			statement: node.statement,
			due: s.card.due.toISOString(),
			lastReviewed: new Date(s.lastReviewed).toISOString(),
			reviews: s.reviews,
			misses: s.misses,
			lastRating: s.lastRating,
		};
		if (isLeechCandidate(s) && !((repairs.get(id) ?? -Infinity) > s.lastMiss!)) queue.slipping.push(item);
		else if (isDueBy(item.due, input.now)) queue.due.push(item);
		else queue.upcoming.push(item);
	}
	queue.due.sort(byDue);
	queue.upcoming.sort(byDue);
	queue.slipping.sort((a, b) => b.misses - a.misses || a.name.localeCompare(b.name));
	return queue;
}
