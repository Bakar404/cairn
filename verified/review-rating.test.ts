// The differential test D and the scheduler checks T1 and T2, against this
// checkout's own review-schedule.ts. verified/check.mjs builds the proved
// crate to WebAssembly and runs this file (see verified/README.md):
//
//   CAIRN_VERIFIED_WASM   the module to compare with (required)
//   CAIRN_VERIFIED_RESULTS where to write the counts as JSON (optional)
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { after, test } from "node:test";
import { replayRetrievals, reviewRating, type ConcludeFacts, type Retrieval } from "../src/core/review-schedule.ts";
import type { ReviewRating } from "../src/core/review-queue.ts";

type Check = Parameters<typeof reviewRating>[1];

const wasmPath = process.env.CAIRN_VERIFIED_WASM;
if (!wasmPath) throw new Error("CAIRN_VERIFIED_WASM is not set. Run node verified/check.mjs, which builds the module and sets it.");
const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), {});
const exported = instance.exports.review_rating_code;
if (typeof exported !== "function") throw new Error(`${wasmPath} doesn't export review_rating_code`);
const reviewRatingCode = exported as (outcome: number, rung: number, careless: number, check: number, judgment: number) => number;

const results: Record<string, unknown> = { wasm: wasmPath };
after(() => {
	const file = process.env.CAIRN_VERIFIED_RESULTS;
	if (!file) return;
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(results, null, "\t")}\n`);
});

// ─── The trusted adapter (TB2): TypeScript inputs to the shim's codes ────
// Maps, not object literals, so "constructor" and friends are unknowns.
const OUTCOME = new Map<unknown, number>([
	["solved", 0],
	["solvedWithHints", 1],
	["movedOn", 2],
	["surrendered", 3],
]);
const RUNG = new Map<unknown, number>([
	["R0", 0],
	["R1", 1],
	["R2", 2],
	["R3", 3],
	["R4", 4],
	["R5", 5],
]);
const JUDGMENT = new Map<unknown, number>([
	["correct", 0],
	["partial", 1],
	["incorrect", 2],
	["unanswered", 3],
]);
const FROM_CODE: readonly (ReviewRating | null)[] = [null, "again", "hard", "good"];

interface RawCheck {
	agrees: boolean;
	judgment: string;
}

function codesOf(facts: ConcludeFacts, check?: RawCheck): [number, number, number, number, number] {
	return [
		OUTCOME.get(facts.outcome) ?? 4,
		RUNG.get(facts.rung) ?? 6,
		facts.missClass === "careless" ? 1 : 0,
		!check ? 0 : check.agrees ? 1 : 2,
		JUDGMENT.get(check?.judgment) ?? 2,
	];
}

function verifiedRating(facts: ConcludeFacts, check?: RawCheck): ReviewRating | null | undefined {
	return FROM_CODE[reviewRatingCode(...codesOf(facts, check))];
}

// ─── D: the shipped TypeScript against the proved code ───────────────────

const OUTCOMES: unknown[] = ["solved", "solvedWithHints", "movedOn", "surrendered", "dismissed", "Solved", "constructor", undefined, null, 42];
const RUNGS: unknown[] = ["R0", "R1", "R2", "R3", "R4", "R5", "R6", "r1", "toString", undefined, null, 3];
const MISS_CLASSES: unknown[] = ["careless", "conceptual", "procedural", "Careless", "__proto__", undefined, 1];
const JUDGMENTS = ["correct", "partial", "incorrect", "unanswered", "bogus", "hasOwnProperty"];
const CHECKS: (RawCheck | undefined)[] = [
	undefined,
	...[true, false].flatMap((agrees) => JUDGMENTS.map((judgment) => ({ agrees, judgment }))),
];

test("D: reviewRating equals the proved code on every input class", () => {
	const mismatches: unknown[] = [];
	const codeTuples = new Set<string>();
	const seen: Record<string, number> = {};
	let cases = 0;
	for (const outcome of OUTCOMES)
		for (const rung of RUNGS)
			for (const missClass of MISS_CLASSES)
				for (const check of CHECKS) {
					const facts = { outcome, rung, missClass };
					const [o, r, c, k, j] = codesOf(facts, check);
					codeTuples.add(`${o},${r},${c},${k},${k === 0 ? "-" : j}`);
					// A stored check is read from disk, so the test also feeds
					// judgments outside the type.
					const shipped = reviewRating(facts, check as Check);
					const verified = verifiedRating(facts, check);
					cases++;
					seen[String(shipped)] = (seen[String(shipped)] ?? 0) + 1;
					if (shipped !== verified) mismatches.push({ facts, check, shipped, verified });
				}
	// Every outcome x rung x careless x check state the shim tells apart:
	// 5 x 7 x 2 x (absent, or 4 agreeing and 4 disagreeing judgments).
	const domain = 5 * 7 * 2 * 9;
	results.differential = {
		cases,
		codeTuplesCovered: codeTuples.size,
		codeDomain: domain,
		results: seen,
		mismatches: mismatches.length,
		firstMismatches: mismatches.slice(0, 10),
	};
	assert.deepEqual(mismatches.slice(0, 5), [], `${mismatches.length} of ${cases} cases differ`);
	assert.equal(codeTuples.size, domain, "the inputs must reach every code the shim tells apart");
	assert.deepEqual(Object.keys(seen).sort(), ["again", "good", "hard", "null"], "every result must occur");
});

// ─── T1, T2: the scheduler (TB3), through Cairn's own replay ─────────────

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = Date.UTC(2026, 0, 5, 18);
const RATINGS: readonly ReviewRating[] = ["again", "hard", "good"];
const LOWER: Readonly<Record<ReviewRating, readonly ReviewRating[]>> = {
	again: [],
	hard: ["again"],
	good: ["hard", "again"],
};

/** Gaps between practice sessions: log-uniform from an hour to two years,
 *  so reviews land early, on time and very late. */
function gap(rand: () => number): number {
	return Math.round(HOUR * Math.exp(rand() * Math.log((730 * DAY) / HOUR)));
}

function randomHistory(rand: () => number, length: number): Retrieval[] {
	const history: Retrieval[] = [];
	let at = START;
	for (let i = 0; i < length; i++) {
		if (i > 0) at += gap(rand);
		history.push({ id: "p", at, rating: RATINGS[Math.floor(rand() * RATINGS.length)] ?? "good" });
	}
	return history;
}

function due(history: readonly Retrieval[]): number {
	const state = replayRetrievals(history).get("p");
	assert.ok(state, "the replay must schedule the proposition");
	return state.card.due.getTime();
}

const show = (history: readonly Retrieval[]) =>
	history.map((r) => `${r.rating}@day${((r.at - START) / DAY).toFixed(1)}`).join(" ");

test("T1: a lower rating never gives a later next review", () => {
	const rand = mulberry32(1);
	let strictlyEarlier = 0;
	const histories = 5000;
	for (let n = 0; n < histories; n++) {
		const before = randomHistory(rand, Math.floor(rand() * 9));
		const last = before.at(-1);
		const at = last ? last.at + gap(rand) : START;
		const rated = (rating: ReviewRating) => due([...before, { id: "p", at, rating }]);
		const again = rated("again");
		const hard = rated("hard");
		const good = rated("good");
		assert.ok(again <= hard && hard <= good, `after ${show(before)}: again ${again}, hard ${hard}, good ${good}`);
		strictlyEarlier += Number(again < hard) + Number(hard < good);
	}
	results.t1 = { histories, comparisons: histories * 2, strictlyEarlier, violations: 0 };
});

test("T2: a rating lowered earlier in a history never gives a later due date", (t) => {
	const rand = mulberry32(2);
	const later: { history: string; lowered: string; laterByDays: number }[] = [];
	const histories = 5000;
	let pairs = 0;
	let earlier = 0;
	for (let n = 0; n < histories; n++) {
		const history = randomHistory(rand, 2 + Math.floor(rand() * 11));
		const baseline = due(history);
		history.slice(0, -1).forEach((retrieval, i) => {
			for (const rating of LOWER[retrieval.rating]) {
				const changed = history.map((r, j) => (j === i ? { ...r, rating } : r));
				const changedDue = due(changed);
				pairs++;
				if (changedDue < baseline) earlier++;
				if (changedDue > baseline) {
					later.push({
						history: show(history),
						lowered: `#${i + 1} ${retrieval.rating} -> ${rating}`,
						laterByDays: Number(((changedDue - baseline) / DAY).toFixed(2)),
					});
				}
			}
		});
	}
	results.t2 = { histories, pairs, earlier, same: pairs - earlier - later.length, later: later.length };
	t.diagnostic(`${pairs} lowered histories: ${earlier} end earlier, ${pairs - earlier - later.length} the same, ${later.length} later`);
	const worst = [...later].sort((a, b) => b.laterByDays - a.laterByDays);
	assert.deepEqual(worst.slice(0, 3), [], `${later.length} of ${pairs} lowered histories end with a later due date`);
});
