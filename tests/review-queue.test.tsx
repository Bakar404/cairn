/**
 * THE DUE-FOR-PRACTICE QUEUE (M20): the practice record replayed through
 * FSRS. Deterministic, with no network and no model:
 *
 *   1. the rating map: the hint ladder, the outcomes, the answer check
 *      (it only ever lowers) and the careless cap (applied last)
 *   2. a session's retrievals: the first counted attempt per proposition;
 *      dismissed, errored, refused and untagged problems never count
 *   3. the queue: FSRS's dates after practice on two days, deleted
 *      propositions dropped, the sort, leeches and their repair
 *   4. the server read and GET /api/practice/due against the real stores
 *   5. the browser half: day labels, the parse, the starts, the pill and
 *      the panel
 */

import "./isolated-data-dir.ts";
import React from "react";
(globalThis as Record<string, unknown>).React = React; // tsx classic-JSX shim (see render-cards.test.tsx)

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { createEmptyCard, fsrs, Rating, type Grade } from "ts-fsrs";

import { GET } from "../app/api/practice/due/route.ts";
import { fetchReviewQueue, ReviewQueuePanel, reviewChipLabel, UPCOMING_SHOWN } from "../components/review-queue-control.tsx";
import type { AssessorJudgment, PracticeAssessment } from "../src/core/contracts.ts";
import {
	concludedByDismissalPair,
	newGraphContextMessage,
	newUserMessage,
	PRACTICE_CONCLUDE_TOOL,
	PRACTICE_PROBLEM_TOOL,
	type LhMessage,
} from "../src/core/native-messages.ts";
import {
	dueLabel,
	isDueBy,
	localDaysUntil,
	parseReviewQueue,
	reteachStart,
	REVIEW_SESSION_LIMIT,
	reviewPracticeStart,
	type ReviewItem,
	type ReviewQueue,
} from "../src/core/review-queue.ts";
import {
	buildReviewQueue,
	LEECH_MISSES,
	retrievalsOf,
	REVIEW_PARAMETERS,
	reviewRating,
	type PracticeRecord,
	type TeachRecord,
} from "../src/core/review-schedule.ts";
import { reviewQueue } from "../src/server/review-queue.ts";
import { stores } from "../src/server/stores.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const STAMPS = {
	api: "faux",
	provider: "test",
	model: "test-model",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
} as const;

const DAY = 86_400_000;

/** A local time on a day in November 2026; 10:00 keeps clear of midnight. */
const nov = (day: number, hour = 10) => new Date(2026, 10, day, hour);

let seq = 0;

function call(callId: string, name: string, args: ToolCall["arguments"], at: number): LhMessage {
	const message: LhMessage & AssistantMessage = {
		id: `msg_a_${callId}`,
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name, arguments: args }],
		timestamp: at,
		...STAMPS,
	};
	return message;
}

function ack(callId: string, name: string, isError: boolean, at: number): LhMessage {
	const message: LhMessage & ToolResultMessage = {
		id: `msg_r_${callId}`,
		role: "toolResult",
		toolCallId: callId,
		toolName: name,
		content: [{ type: "text", text: isError ? "Refused." : "Done." }],
		details: null,
		isError,
		timestamp: at,
	};
	return message;
}

/** The tutor answering in a teach session. */
function tutor(stopReason: AssistantMessage["stopReason"], at: number): LhMessage {
	const message: LhMessage & AssistantMessage = {
		id: `msg_t_${++seq}`,
		role: "assistant",
		content: [{ type: "text", text: "Here is another way in." }],
		timestamp: at,
		...STAMPS,
		stopReason,
	};
	return message;
}

/** One problem, posed (`p_<key>`) and concluded (`c_<key>`) at `at`. */
function problem(
	key: string,
	target: string[] | undefined,
	facts: ToolCall["arguments"] | "dismissed",
	at: Date,
	{ errored = false, refused = false }: { errored?: boolean; refused?: boolean } = {},
): LhMessage[] {
	const t = at.getTime();
	const p = `p_${key}`;
	const input: ToolCall["arguments"] = {
		statement: `Problem ${key}`,
		mode: "recall",
		modelSolution: "The worked solution.",
		...(target ? { target } : {}),
	};
	const posed = [call(p, PRACTICE_PROBLEM_TOOL, input, t), ack(p, PRACTICE_PROBLEM_TOOL, refused, t)];
	if (facts === "dismissed") {
		const [c, r] = concludedByDismissalPair(p);
		return [...posed, { ...c, timestamp: t }, { ...r, timestamp: t }];
	}
	const c = `c_${key}`;
	return [...posed, call(c, PRACTICE_CONCLUDE_TOOL, facts, t), ack(c, PRACTICE_CONCLUDE_TOOL, errored, t)];
}

const session = (...problems: LhMessage[][]): PracticeRecord => ({ messages: problems.flat() });

const node = (id: string, name: string) => ({
	id,
	name,
	statement: `${name} holds.`,
	aliases: [] as string[],
	createdAt: "2026-10-01T00:00:00.000Z",
	provenance: [],
});

const NODES = [node("n_1", "Modus ponens"), node("n_2", "Contraposition"), node("n_3", "Soundness"), node("n_4", "Validity")];

function assessment(concludeCallId: string, judgment: AssessorJudgment, agrees: boolean): PracticeAssessment {
	return {
		concludeCallId,
		problemCallId: concludeCallId.replace(/^c_/, "p_"),
		at: "2026-11-02T12:00:00.000Z",
		outcome: "solved",
		judgment,
		reason: "Checked.",
		agrees,
		steps: [],
	};
}

/** An independent scheduler with the same settings: the dates to expect. */
const reference = fsrs({ ...REVIEW_PARAMETERS });

function referenceDue(steps: ReadonlyArray<readonly [Date, Grade]>): string {
	let card = createEmptyCard(steps[0]![0]);
	for (const [when, grade] of steps) card = reference.next(card, when, grade).card;
	return card.due.toISOString();
}

type Bucket = "due" | "upcoming" | "slipping";

/** Where a proposition landed in the queue, if anywhere. */
function where(queue: ReviewQueue, id: string): [Bucket, ReviewItem] | undefined {
	for (const bucket of ["due", "upcoming", "slipping"] as const) {
		const item = queue[bucket].find((i) => i.id === id);
		if (item) return [bucket, item];
	}
	return undefined;
}

// ─── 1. the rating map ───────────────────────────────────────────────────────

describe("the rating map", () => {
	it("rates by the hint ladder: R0–R1 good, R2 hard, R3–R5 again", () => {
		const table: ReadonlyArray<readonly [unknown, unknown, string | null]> = [
			["solved", "R0", "good"],
			["solved", "R1", "good"],
			["solvedWithHints", "R1", "good"],
			["solvedWithHints", "R2", "hard"],
			["solvedWithHints", "R3", "again"],
			["solvedWithHints", "R4", "again"],
			["solvedWithHints", "R5", "again"],
			// Solved, yet recorded at a giveaway rung: the rung wins.
			["solved", "R3", "again"],
			["solved", "R5", "again"],
			// No rung recorded: a clean solve is Good, a hinted one Hard.
			["solved", null, "good"],
			["solved", undefined, "good"],
			["solvedWithHints", null, "hard"],
			["movedOn", "R2", "again"],
			["surrendered", null, "again"],
			// Not a retrieval: dismissed, or an outcome this build doesn't know.
			["dismissed", null, null],
			["gaveUp", null, null],
			[undefined, "R0", null],
		];
		for (const [outcome, rung, want] of table) {
			assert.equal(reviewRating({ outcome, rung }), want, `${String(outcome)} at ${String(rung)}`);
		}
	});

	it("the answer check only ever lowers a rating", () => {
		const check = (judgment: AssessorJudgment, agrees: boolean) => ({ judgment, agrees });
		const clean = { outcome: "solved", rung: "R0" };
		assert.equal(reviewRating(clean, check("partial", false)), "hard");
		assert.equal(reviewRating(clean, check("incorrect", false)), "again");
		assert.equal(reviewRating(clean, check("unanswered", false)), "again");
		assert.equal(reviewRating(clean, check("correct", true)), "good");
		// Never raises: a giveaway stays Again, and so does a miss the check calls correct.
		assert.equal(reviewRating({ outcome: "solvedWithHints", rung: "R4" }, check("partial", false)), "again");
		assert.equal(reviewRating({ outcome: "movedOn" }, check("correct", false)), "again");
	});

	it("a careless miss is never worse than hard, and that applies last", () => {
		assert.equal(reviewRating({ outcome: "movedOn", missClass: "careless" }), "hard");
		assert.equal(reviewRating({ outcome: "solvedWithHints", rung: "R4", missClass: "careless" }), "hard");
		assert.equal(reviewRating({ outcome: "solved", rung: "R0", missClass: "careless" }), "good");
		assert.equal(
			reviewRating({ outcome: "solved", rung: "R0", missClass: "careless" }, { judgment: "incorrect", agrees: false }),
			"hard",
		);
		assert.equal(reviewRating({ outcome: "movedOn", missClass: "structural" }), "again");
		assert.equal(reviewRating({ outcome: "dismissed", missClass: "careless" }), null);
	});
});

// ─── 2. a session's retrievals ───────────────────────────────────────────────

describe("a session's retrievals", () => {
	it("one per target, at the conclude's time", () => {
		const at = nov(2);
		assert.deepEqual(retrievalsOf(session(problem("m", ["n_1", "n_2", "n_1"], { outcome: "solved", rung: "R0" }, at))), [
			{ id: "n_1", at: at.getTime(), rating: "good" },
			{ id: "n_2", at: at.getTime(), rating: "good" },
		]);
	});

	it("within a session, only the first counted attempt is the retrieval", () => {
		const record = session(
			problem("first", ["n_1"], { outcome: "movedOn", rung: null, missClass: "cue", retest: true }, nov(2, 10)),
			problem("retest", ["n_1"], { outcome: "solved", rung: "R0", missClass: null, retest: false }, nov(2, 11)),
		);
		assert.deepEqual(retrievalsOf(record), [{ id: "n_1", at: nov(2, 10).getTime(), rating: "again" }]);
	});

	it("dismissed, errored, refused and untagged problems never count, nor use up the first attempt", () => {
		const record = session(
			problem("dismissed", ["n_1"], "dismissed", nov(2, 9)),
			problem("errored", ["n_1"], { outcome: "movedOn" }, nov(2, 10), { errored: true }),
			problem("untagged", undefined, { outcome: "movedOn" }, nov(2, 11)),
			problem("counted", ["n_1"], { outcome: "solved", rung: "R1" }, nov(2, 12)),
		);
		assert.deepEqual(retrievalsOf(record), [{ id: "n_1", at: nov(2, 12).getTime(), rating: "good" }]);
		const refused = session(problem("refused", ["n_1"], { outcome: "solved", rung: "R0" }, nov(2), { refused: true }));
		assert.deepEqual(retrievalsOf(refused), []);
	});

	it("an answer check that disagrees lowers the rating", () => {
		const record: PracticeRecord = {
			...session(problem("checked", ["n_1"], { outcome: "solved", rung: "R0" }, nov(2))),
			assessments: [assessment("c_checked", "incorrect", false)],
		};
		assert.equal(retrievalsOf(record)[0]?.rating, "again");
	});

	it("a conclude with no timestamp takes the session's creation time", () => {
		const record: PracticeRecord = {
			messages: problem("old", ["n_1"], { outcome: "solved", rung: "R0" }, new Date(0)),
			createdAt: "2026-11-02T09:00:00.000Z",
		};
		assert.equal(retrievalsOf(record)[0]?.at, Date.parse("2026-11-02T09:00:00.000Z"));
	});
});

// ─── 3. the queue ────────────────────────────────────────────────────────────

describe("the queue", () => {
	it("after practice on two days, each proposition is due when FSRS says", () => {
		const day1 = nov(2);
		const day2 = nov(3);
		const first = session(
			problem("a", ["n_1"], { outcome: "solved", rung: "R0" }, day1),
			problem("b", ["n_2"], { outcome: "movedOn", rung: null, missClass: "cue" }, day1),
		);
		const second = session(problem("c", ["n_2"], { outcome: "solvedWithHints", rung: "R2" }, day2));
		const now = nov(5, 12);
		// Out of order on purpose: the replay sorts by time.
		const queue = buildReviewQueue({ practice: [second, first], nodes: NODES, now });

		const [bucket1, n1] = where(queue, "n_1")!;
		assert.equal(n1.due, referenceDue([[day1, Rating.Good]]));
		assert.equal(n1.due, new Date(day1.getTime() + 3 * DAY).toISOString(), "a first Good is due three days on");
		assert.equal(bucket1, "due");
		assert.deepEqual([n1.reviews, n1.misses, n1.lastRating, n1.lastReviewed], [1, 0, "good", day1.toISOString()]);

		const [bucket2, n2] = where(queue, "n_2")!;
		assert.equal(n2.due, referenceDue([[day1, Rating.Again], [day2, Rating.Hard]]));
		assert.equal(bucket2, isDueBy(n2.due, now) ? "due" : "upcoming");
		assert.deepEqual([n2.reviews, n2.misses, n2.lastRating, n2.lastReviewed], [2, 1, "hard", day2.toISOString()]);

		assert.equal(where(queue, "n_3"), undefined, "never practiced, never queued");
	});

	it("drops propositions deleted from the graph", () => {
		const queue = buildReviewQueue({
			practice: [session(problem("gone", ["n_1", "n_deleted"], { outcome: "solved", rung: "R0" }, nov(2)))],
			nodes: NODES,
			now: nov(3),
		});
		assert.deepEqual([...queue.due, ...queue.upcoming, ...queue.slipping].map((i) => i.id), ["n_1"]);
	});

	it("sorts the most overdue first, then the soonest upcoming", () => {
		const good = (id: string, day: number) => session(problem(`${id}-${day}`, [id], { outcome: "solved", rung: "R0" }, nov(day)));
		// A first Good is due three days on: n_2 on the 4th, n_1 the 5th, n_4 the 9th, n_3 the 10th.
		const queue = buildReviewQueue({
			practice: [good("n_1", 2), good("n_3", 7), good("n_2", 1), good("n_4", 6)],
			nodes: NODES,
			now: nov(7, 12),
		});
		assert.deepEqual(queue.due.map((i) => i.id), ["n_2", "n_1"]);
		assert.deepEqual(queue.upcoming.map((i) => i.id), ["n_4", "n_3"]);
	});
});

describe("leeches", () => {
	const missedOn = (id: string, days: number[]) =>
		days.map((day) => session(problem(`${id}-${day}`, [id], { outcome: "surrendered", rung: null }, nov(day))));
	// Soundness missed on the 2nd, 4th and 6th: three misses, the latest a miss.
	const misses = missedOn("n_3", [2, 4, 6]);
	const teach = (pickedAt: Date, reply: AssistantMessage["stopReason"] | null): TeachRecord => ({
		messages: [
			{ ...newGraphContextMessage([{ id: "n_3", name: "Soundness", statement: "Soundness holds." }], []), timestamp: pickedAt.getTime() },
			{ ...newUserMessage("Teach it to me again."), timestamp: pickedAt.getTime() },
			...(reply ? [tutor(reply, pickedAt.getTime() + 60_000)] : []),
		],
	});
	const queueWith = (teachChats: TeachRecord[]) =>
		buildReviewQueue({ practice: misses, nodes: NODES, teachSince: () => teachChats, now: nov(8) });

	it(`${LEECH_MISSES} misses, the latest a miss: it keeps slipping`, () => {
		const queue = queueWith([]);
		assert.deepEqual(queue.slipping.map((i) => [i.id, i.misses, i.lastRating]), [["n_3", 3, "again"]]);
		assert.equal(queue.due.length + queue.upcoming.length, 0);
	});

	it("fewer misses, or a success since the last, is not a leech", () => {
		assert.equal(buildReviewQueue({ practice: misses.slice(0, 2), nodes: NODES, now: nov(8) }).slipping.length, 0);
		const recovered = buildReviewQueue({
			practice: [...misses, session(problem("ok", ["n_3"], { outcome: "solved", rung: "R1" }, nov(7)))],
			nodes: NODES,
			now: nov(8),
		});
		assert.equal(recovered.slipping.length, 0);
		assert.equal(where(recovered, "n_3")?.[1].misses, 3);
	});

	it("a teach session that picked it after the last miss, and answered, repairs it", () => {
		const queue = queueWith([teach(nov(7), "stop")]);
		assert.equal(queue.slipping.length, 0);
		assert.notEqual(where(queue, "n_3"), undefined, "back on its FSRS date");
	});

	it("a pick before the last miss, an unanswered pick or an errored answer repairs nothing", () => {
		for (const chat of [teach(nov(5), "stop"), teach(nov(7), null), teach(nov(7), "error")]) {
			assert.deepEqual(queueWith([chat]).slipping.map((i) => i.id), ["n_3"]);
		}
	});

	it("teach sessions are read only when something looks like a leech, from its last miss on", () => {
		const calls: Date[] = [];
		const teachSince = (since: Date) => {
			calls.push(since);
			return [];
		};
		buildReviewQueue({ practice: misses.slice(0, 2), nodes: NODES, teachSince, now: nov(8) });
		assert.equal(calls.length, 0);
		buildReviewQueue({ practice: misses, nodes: NODES, teachSince, now: nov(8) });
		assert.deepEqual(calls.map((d) => d.getTime()), [nov(6).getTime()]);
	});

	it("the most missed slip first, then by name", () => {
		const queue = buildReviewQueue({
			practice: [...misses, ...missedOn("n_4", [1, 2, 3, 5]), ...missedOn("n_1", [3, 4, 6])],
			nodes: NODES,
			now: nov(8),
		});
		assert.deepEqual(queue.slipping.map((i) => i.id), ["n_4", "n_1", "n_3"]);
	});
});

// ─── 4. the server read and the route ────────────────────────────────────────

describe("the server read and GET /api/practice/due", () => {
	const { chatStore, graphStore } = stores;
	const ago = (days: number) => new Date(Date.now() - days * DAY);

	it("replays the stored practice sessions against the live graph", async () => {
		graphStore.appendNode(node("n_srv", "Contrapositive"));
		const practicedAt = ago(5);
		const chat = chatStore.createChat("Practice: contrapositive", "practice");
		chatStore.saveMessages(chat.id, problem("srv", ["n_srv", "n_srv_deleted"], { outcome: "solved", rung: "R0" }, practicedAt));

		const queue = reviewQueue();
		const [bucket, item] = where(queue, "n_srv")!;
		assert.equal(bucket, "due", "a Good five days ago was due two days ago");
		assert.equal(item.due, new Date(practicedAt.getTime() + 3 * DAY).toISOString());
		assert.equal(where(queue, "n_srv_deleted"), undefined);

		const res = await GET();
		assert.equal(res.status, 200);
		const served = parseReviewQueue(await res.json());
		assert.ok(served, "the route answers a queue the client can read");
		assert.equal(where(served, "n_srv")?.[1].due, item.due);
	});

	it("a teach session answered after the last miss takes a leech off the slipping list", () => {
		graphStore.appendNode(node("n_leech", "Biconditional"));
		for (const days of [9, 7, 5]) {
			const chat = chatStore.createChat("Practice: biconditional", "practice");
			chatStore.saveMessages(chat.id, problem(`leech${days}`, ["n_leech"], { outcome: "surrendered" }, ago(days)));
		}
		assert.equal(where(reviewQueue(), "n_leech")?.[0], "slipping");

		const pickedAt = ago(1).getTime();
		const teachChat = chatStore.createChat("Teach again: Biconditional");
		chatStore.saveMessages(teachChat.id, [
			{ ...newGraphContextMessage([{ id: "n_leech", name: "Biconditional", statement: "Biconditional holds." }], []), timestamp: pickedAt },
			{ ...newUserMessage("Teach it to me again."), timestamp: pickedAt },
			tutor("stop", pickedAt + 60_000),
		]);
		assert.notEqual(where(reviewQueue(), "n_leech")?.[0], "slipping");
	});
});

// ─── 5. the browser half ─────────────────────────────────────────────────────

const reviewItem = (id: string, due: Date, extra: Partial<ReviewItem> = {}): ReviewItem => ({
	id,
	name: `Name ${id}`,
	statement: `Statement ${id}.`,
	due: due.toISOString(),
	lastReviewed: nov(1).toISOString(),
	reviews: 1,
	misses: 0,
	lastRating: "good",
	...extra,
});

const EMPTY: ReviewQueue = { at: nov(5).toISOString(), due: [], upcoming: [], slipping: [] };

describe("the browser half", () => {
	const now = nov(5, 12);

	it("labels due dates by the local calendar day", () => {
		const label = (due: Date) => dueLabel(due.toISOString(), now);
		assert.equal(label(new Date(2026, 10, 4, 23, 59)), "1 day overdue");
		assert.equal(label(new Date(2026, 10, 2, 8)), "3 days overdue");
		assert.equal(label(new Date(2026, 10, 5, 0, 1)), "due today");
		assert.equal(label(new Date(2026, 10, 5, 23, 59)), "due today");
		assert.equal(label(new Date(2026, 10, 6, 0, 1)), "tomorrow");
		assert.equal(label(new Date(2026, 10, 11, 9)), "in 6 days");
		assert.equal(label(new Date(2026, 10, 12, 9)), "2026-11-12");
		assert.equal(isDueBy(new Date(2026, 10, 5, 23, 59).toISOString(), now), true);
		assert.equal(isDueBy(new Date(2026, 10, 6, 0, 1).toISOString(), now), false);
	});

	it("counts calendar days across a daylight-saving change", () => {
		// Clocks change on March 8 and November 1, 2026 in much of North America.
		assert.equal(localDaysUntil(new Date(2026, 2, 9, 0, 30).toISOString(), new Date(2026, 2, 7, 12)), 2);
		assert.equal(localDaysUntil(new Date(2026, 10, 2, 0, 30).toISOString(), new Date(2026, 9, 31, 23)), 2);
	});

	it("parses the route's answer, and refuses a foreign shape", () => {
		const queue: ReviewQueue = {
			...EMPTY,
			due: [reviewItem("d", nov(4))],
			upcoming: [reviewItem("u", nov(9))],
			slipping: [reviewItem("s", nov(4), { misses: 3, lastRating: "again" })],
		};
		assert.deepEqual(parseReviewQueue(JSON.parse(JSON.stringify(queue))), queue);
		const foreign: unknown[] = [
			null,
			"queue",
			{ ...queue, at: 5 },
			{ ...queue, due: undefined },
			{ ...queue, upcoming: [{ ...queue.upcoming[0], lastRating: "easy" }] },
			{ ...queue, due: [{ ...queue.due[0], due: "someday" }] },
		];
		for (const raw of foreign) assert.equal(parseReviewQueue(raw), null, JSON.stringify(raw));
	});

	it("Practice these takes the most overdue, ten at most", () => {
		const due = Array.from({ length: 12 }, (_, i) => reviewItem(`d${i}`, nov(1)));
		const start = reviewPracticeStart(due);
		assert.equal(start.kind, "practice");
		assert.equal(start.picks.length, REVIEW_SESSION_LIMIT);
		assert.deepEqual(start.picks[0], { id: "d0", name: "Name d0", statement: "Statement d0." });
		assert.equal(start.title, "Review: Name d0 and 9 more");
		assert.equal(reviewPracticeStart(due.slice(0, 1)).title, "Review: Name d0");
	});

	it("Teach again starts a teach session on the one proposition", () => {
		assert.deepEqual(reteachStart(reviewItem("s", nov(4), { misses: 3, lastRating: "again" })), {
			kind: "teach",
			title: "Teach again: Name s",
			prompt: 'I keep missing "Name s" in practice. Teach it to me again, a different way this time.',
			picks: [{ id: "s", name: "Name s", statement: "Statement s." }],
		});
	});

	it("the pill says what's due, else what's slipping, else when the next review is", () => {
		const slipping = [reviewItem("s", nov(4), { misses: 3, lastRating: "again" })];
		const upcoming = [reviewItem("u", nov(6))];
		assert.equal(reviewChipLabel(EMPTY, now), null);
		assert.equal(reviewChipLabel({ ...EMPTY, upcoming }, now), "Next review tomorrow");
		assert.equal(reviewChipLabel({ ...EMPTY, upcoming, slipping }, now), "1 slipping");
		assert.equal(reviewChipLabel({ ...EMPTY, due: [reviewItem("a", nov(4)), reviewItem("b", nov(5))], slipping }, now), "2 due");
	});

	const count = (html: string, testId: string) => html.split(`data-testid="${testId}"`).length - 1;
	/** Whether the button carries the disabled attribute (its classes name `disabled:` variants regardless). */
	const disabled = (html: string, testId: string) => {
		const tag = html.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`))?.[0];
		assert.ok(tag, `a ${testId} button`);
		return / disabled=""/.test(tag);
	};
	const panel = (queue: ReviewQueue, busy = false) =>
		renderToStaticMarkup(<ReviewQueuePanel queue={queue} now={now} busy={busy} onStart={() => {}} />);

	it("the panel lists what's due with its dates, what slips with its misses, and the next few", () => {
		const html = panel({
			...EMPTY,
			due: Array.from({ length: 12 }, (_, i) => reviewItem(`d${i}`, nov(1 + (i % 4)))),
			slipping: [reviewItem("s", nov(4), { misses: 3, lastRating: "again" })],
			upcoming: Array.from({ length: 7 }, (_, i) => reviewItem(`u${i}`, nov(6 + i))),
		});
		assert.equal(count(html, "review-due-item"), 12);
		assert.equal(count(html, "review-upcoming-item"), UPCOMING_SHOWN);
		assert.equal(count(html, "review-slipping-item"), 1);
		assert.ok(html.includes("1 day overdue") && html.includes("4 days overdue"));
		assert.ok(html.includes(`title="2026-11-04"`) && html.includes(nov(4).toISOString()), "the exact date rides the label");
		assert.ok(html.includes(`Practice these takes the ${REVIEW_SESSION_LIMIT} most overdue.`));
		assert.ok(html.includes("Missed 3 times") && html.includes(`aria-label="Teach again: Name s"`));
		assert.equal(disabled(html, "review-practice"), false);
		assert.equal(disabled(html, "review-reteach"), false);
	});

	it("the panel leaves out empty sections and disables its starts while busy", () => {
		const quiet = panel({ ...EMPTY, upcoming: [reviewItem("u", nov(9))] });
		assert.equal(count(quiet, "review-practice"), 0);
		assert.ok(!quiet.includes("Due for practice") && !quiet.includes("Keeps slipping") && quiet.includes("Coming up"));
		const busy = panel({ ...EMPTY, due: [reviewItem("d", nov(4))], slipping: [reviewItem("s", nov(4), { misses: 3 })] }, true);
		assert.equal(disabled(busy, "review-practice"), true);
		assert.equal(disabled(busy, "review-reteach"), true);
		assert.ok(!busy.includes("most overdue."), "ten or fewer due: no cap note");
	});

	it("fetchReviewQueue reads the route uncached, and fails soft", async () => {
		const queue: ReviewQueue = { ...EMPTY, due: [reviewItem("d", nov(4))] };
		const calls: unknown[][] = [];
		const ok = (async (...args: unknown[]) => {
			calls.push(args);
			return Response.json(queue);
		}) as unknown as typeof fetch;
		assert.deepEqual(await fetchReviewQueue(ok), queue);
		assert.deepEqual(calls, [["/api/practice/due", { cache: "no-store" }]]);
		const failing: Array<() => Promise<Response>> = [
			async () => new Response("nope", { status: 500 }),
			async () => {
				throw new Error("offline");
			},
			async () => Response.json({ due: "x" }),
		];
		for (const f of failing) assert.equal(await fetchReviewQueue(f as unknown as typeof fetch), null);
	});
});
