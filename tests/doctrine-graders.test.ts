/**
 * THE DOCTRINE EVALS (M23): deterministic graders read a practice
 * transcript and report where the tutor broke one of its laws; scripted
 * learners play the live sessions they grade. All deterministic, with no
 * network:
 *
 *   1. the graders, one law at a time, on hand-built transcripts
 *   2. the outline the rubric judge reads
 *   3. the synthetic learners and their slips
 *   4. the rubric judge against a scripted faux engine
 *   5. the eval command: recorded transcripts, the report, the arguments
 *   6. whole eval sessions through the real chat handler, scripted
 */

import "./isolated-data-dir.ts";

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	type AssistantMessage,
	type FauxResponseStep,
	type ToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";

import type { PiEngine } from "../src/agent/models.ts";
import type { AssessorResult } from "../src/agent/subagents/assessor.ts";
import { RUBRIC_INSTRUCTIONS, RUBRIC_TOOL, runTutorRubric } from "../src/agent/subagents/tutor-rubric.ts";
import { createPracticeAgent } from "../src/agent/teacher-agent.ts";
import type { PracticeAssessment } from "../src/core/contracts/chat.ts";
import {
	gradeTranscript,
	transcriptOutline,
	transcriptPasses,
	type GraderId,
	type GraderResult,
} from "../src/core/doctrine-graders.ts";
import {
	concludedByDismissalPair,
	newGraphContextMessage,
	newNextMessage,
	newProblemDismissedMarker,
	newThinkingMessage,
	newUserMessage,
	PRACTICE_CONCLUDE_TOOL,
	PRACTICE_PROBLEM_TOOL,
	SEND_TO_USER_TOOL,
	type GraphContextPick,
	type LhMessage,
} from "../src/core/native-messages.ts";
import type { AssessmentInput } from "../src/core/practice-assessment.ts";
import { ASK_FOR_PROBLEM, LEARNER_OPENING, MAX_LEARNER_INPUTS, slipOf, syntheticLearner } from "../src/core/synthetic-learners.ts";
import { runEvalSession, type EvalSessionOptions } from "../src/server/practice-evals.ts";
import { stores } from "../src/server/stores.ts";
import {
	ascii,
	formatReport,
	gradeRecordedDir,
	main,
	parseArgs,
	parseRecorded,
	RECORD_VERSION,
	sessionFileName,
} from "../scripts/evals.ts";

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

const AT = "2026-11-02T12:00:00.000Z";

const PIGEONHOLE: GraphContextPick = {
	id: "n_pigeonhole",
	name: "Pigeonhole principle",
	statement: "With more items than boxes, some box holds at least two items.",
};

/** Its committed solution has 31 distinct word 4-grams and none of them
 *  is in the statement: the share tests below count against that. */
const SOCKS = {
	statement: "A drawer holds 5 red socks and 5 blue socks. In the dark, how many socks must you take to be sure of a matching pair?",
	mode: "recall",
	target: ["n_pigeonhole"],
	modelSolution:
		"Treat the two colors as boxes and the socks as items. Two socks can still be one of each color. A third sock must repeat a color, so three socks guarantee a matching pair.",
};

const CARDS = {
	statement: "How many cards must you draw from a standard deck to be sure two share a suit?",
	mode: "recall",
	target: ["n_pigeonhole"],
	modelSolution:
		"The four suits are the boxes and the cards are the items. Four cards can all differ in suit. A fifth card must repeat a suit, so five cards guarantee two of the same suit.",
};

/** His answer to the socks problem, in his own words. */
const FINAL = "Two socks can still be one of each color, so the third sock must repeat a color: three socks.";
const CARDS_ANSWER = "Five cards: four can all differ in suit, so a fifth card must repeat a suit.";
const OPENING = "Ready, give me a problem.";
const WARM_UP = "Here is a warm-up.";
const WRAP = "Well reasoned. Say when you want another.";

let seq = 0;

function call(callId: string, name: string, args: ToolCall["arguments"]): LhMessage {
	const message: LhMessage & AssistantMessage = {
		id: `msg_a_${callId}`,
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name, arguments: args }],
		timestamp: 1,
		...STAMPS,
	};
	return message;
}

/** One assistant message carrying several tool calls. */
function calls(blocks: ReadonlyArray<{ id: string; name: string; args: ToolCall["arguments"] }>): LhMessage {
	const message: LhMessage & AssistantMessage = {
		id: `msg_a_multi_${++seq}`,
		role: "assistant",
		content: blocks.map((b) => ({ type: "toolCall" as const, id: b.id, name: b.name, arguments: b.args })),
		timestamp: 1,
		...STAMPS,
	};
	return message;
}

function ack(callId: string, name: string, isError = false): LhMessage {
	const message: LhMessage & ToolResultMessage = {
		id: `msg_r_${callId}`,
		role: "toolResult",
		toolCallId: callId,
		toolName: name,
		content: [{ type: "text", text: isError ? "Refused." : "Done." }],
		details: null,
		isError,
		timestamp: 2,
	};
	return message;
}

/** The tutor posing a problem, with its ack. */
function pose(callId = "call_p1", input: ToolCall["arguments"] = SOCKS, refused = false): LhMessage[] {
	return [call(callId, PRACTICE_PROBLEM_TOOL, input), ack(callId, PRACTICE_PROBLEM_TOOL, refused)];
}

/** The tutor concluding the open problem, with its ack. */
function conclude(callId: string, outcome: string, opts: { refused?: boolean; extra?: ToolCall["arguments"] } = {}): LhMessage[] {
	return [
		call(callId, PRACTICE_CONCLUDE_TOOL, { outcome, verdict: "Clean work.", ...opts.extra }),
		ack(callId, PRACTICE_CONCLUDE_TOOL, opts.refused),
	];
}

/** The tutor talking (a warm-up, a hint, a wrap-up). */
function tutor(text: string): LhMessage {
	const message: LhMessage & AssistantMessage = {
		id: `msg_t_${++seq}`,
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: 1,
		...STAMPS,
		stopReason: "stop",
	};
	return message;
}

const ctx = (picks: readonly GraphContextPick[] = [PIGEONHOLE]) => newGraphContextMessage(picks, []);

/**
 * Two problems taught by the book; every law gets a chance to break:
 *
 *   0 context, 1 opening, 2 warm-up, 3-4 socks posed, 5 "Two socks?",
 *   6 a hint, 7 his answer, 8-9 concluded, 10 wrap-up, 11 Next,
 *   12-13 cards posed, 14 his answer, 15-16 concluded, 17 wrap-up.
 */
function lesson(): LhMessage[] {
	return [
		ctx(),
		newUserMessage(OPENING),
		tutor(WARM_UP),
		...pose("call_p1", SOCKS),
		newThinkingMessage("call_p1", "Two socks?"),
		tutor("Could two socks still be different colors? Picture the worst case."),
		newThinkingMessage("call_p1", FINAL),
		...conclude("call_c1", "solved"),
		tutor(WRAP),
		newNextMessage(),
		...pose("call_p2", CARDS),
		newThinkingMessage("call_p2", CARDS_ANSWER),
		...conclude("call_c2", "solved"),
		tutor("That is the pattern."),
	];
}

const STUCK = ["Two socks?", "Hmm, still not sure.", "I am lost."];

/**
 * One socks problem with a hint per stuck line:
 *
 *   0 context, 1 opening, 2 warm-up, 3-4 posed, then for hint i:
 *   5+2i stuck, 6+2i the hint; then (k hints) 5+2k his answer,
 *   6+2k / 7+2k concluded solved, 8+2k wrap-up.
 */
function practiceRun(
	hints: readonly string[],
	opts: { poseInput?: ToolCall["arguments"]; warmUp?: string; picks?: readonly GraphContextPick[] } = {},
): LhMessage[] {
	const messages: LhMessage[] = [
		ctx(opts.picks),
		newUserMessage(OPENING),
		tutor(opts.warmUp ?? WARM_UP),
		...pose("call_p1", opts.poseInput ?? SOCKS),
	];
	hints.forEach((hint, i) => messages.push(newThinkingMessage("call_p1", STUCK[i] ?? "Still stuck."), tutor(hint)));
	messages.push(newThinkingMessage("call_p1", FINAL), ...conclude("call_c1", "solved"), tutor(WRAP));
	return messages;
}

function assessment(concludeCallId: string, problemCallId: string, agrees = true): PracticeAssessment {
	return {
		concludeCallId,
		problemCallId,
		at: AT,
		outcome: "solved",
		judgment: agrees ? "correct" : "incorrect",
		reason: agrees ? "Right." : "He counted wrong.",
		agrees,
		model: "test:cheap-model",
		steps: [],
	};
}

const agreeing = () => [assessment("call_c1", "call_p1"), assessment("call_c2", "call_p2")];

const failing = (results: readonly GraderResult[]): GraderId[] => results.filter((r) => !r.pass).map((r) => r.id);

function grader(results: readonly GraderResult[], id: GraderId): GraderResult {
	const found = results.find((r) => r.id === id);
	assert.ok(found, `no ${id} result`);
	return found;
}

const evidenceOf = (results: readonly GraderResult[], id: GraderId) =>
	grader(results, id).findings.map((f) => f.evidence).join("\n");

/** A scripted pi engine (faux provider): the response queue is the model. */
function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** What a model call saw: the system prompt and every user turn's text. */
function seenBy(context: unknown): { system: string; user: string } {
	const messages = (context as { messages?: unknown[] }).messages ?? [];
	const user = messages
		.filter((m): m is { role: string; content: unknown } => (m as { role?: string }).role === "user")
		.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
		.join("\n");
	return { system: getCurrentSystemPrompt(messages as Parameters<typeof getCurrentSystemPrompt>[0]), user };
}

// ─── 1. the graders ──────────────────────────────────────────────────────────

describe("gradeTranscript (a session that keeps the laws)", () => {
	it("two problems taught by the book: all eight graders apply and pass, in a fixed order", () => {
		const results = gradeTranscript(lesson(), { assessments: agreeing() });
		assert.deepEqual(
			results.map((r) => r.id),
			[
				"commit-before-pose",
				"one-active-problem",
				"conclude-gate",
				"pause-law",
				"no-leak",
				"one-rung-per-request",
				"never-announce",
				"verdict-honesty",
			],
		);
		for (const r of results) {
			assert.ok(r.applicable, `${r.id} applies`);
			assert.ok(r.pass, `${r.id} passes: ${JSON.stringify(r.findings)}`);
			assert.ok(r.title.length > 0);
		}
		assert.ok(transcriptPasses(results));
	});

	it("a dismissed problem, then an easier one he asked for: every grader passes", () => {
		const messages = [
			ctx(),
			newUserMessage(OPENING),
			tutor(WARM_UP),
			...pose("call_p1", SOCKS),
			newProblemDismissedMarker("call_p1"),
			...concludedByDismissalPair("call_p1"),
			newUserMessage("Something easier, please."),
			...pose("call_p2", CARDS),
			newThinkingMessage("call_p2", CARDS_ANSWER),
			...conclude("call_c2", "solved"),
			tutor("That is the pattern."),
		];
		const results = gradeTranscript(messages);
		assert.deepEqual(failing(results), [], JSON.stringify(results.flatMap((r) => r.findings)));
	});

	it("a session that never posed a problem passes", () => {
		const results = gradeTranscript([ctx(), newUserMessage(OPENING), tutor("What would you like to practice?")]);
		assert.ok(transcriptPasses(results));
	});
});

describe("commit-before-pose", () => {
	const cases: ReadonlyArray<[string, ToolCall["arguments"], RegExp]> = [
		["no solution", { modelSolution: "" }, /without committing a solution/],
		["a bare answer", { modelSolution: "Three socks." }, /Committed only "Three socks\."/],
		["the statement again", { modelSolution: SOCKS.statement }, /repeats the statement/],
		["no statement", { statement: "" }, /empty statement/],
	];
	for (const [label, over, evidence] of cases) {
		it(`flags a pose with ${label}, and nothing else`, () => {
			const results = gradeTranscript(practiceRun([], { poseInput: { ...SOCKS, ...over } }));
			assert.deepEqual(failing(results), ["commit-before-pose"]);
			assert.match(evidenceOf(results, "commit-before-pose"), evidence);
		});
	}
});

describe("one-active-problem", () => {
	it("flags a second pose while the first is open, even though the tool refused it", () => {
		const messages = [
			ctx(),
			newUserMessage(OPENING),
			tutor(WARM_UP),
			...pose("call_p1", SOCKS),
			newThinkingMessage("call_p1", "Two socks?"),
			...pose("call_p2", CARDS, true),
			tutor("One at a time: think about the worst case first."),
			newThinkingMessage("call_p1", FINAL),
			...conclude("call_c1", "solved"),
			tutor(WRAP),
		];
		const results = gradeTranscript(messages);
		assert.deepEqual(failing(results), ["one-active-problem"]);
		assert.match(evidenceOf(results, "one-active-problem"), /while ".+" was still open \(the tool refused it\)/);
	});

	it("flags a conclusion with no problem open", () => {
		const messages = [
			...practiceRun([]),
			newUserMessage("What was the trick?"),
			...conclude("call_c9", "solved", { refused: true }),
			tutor("The worst case is the key."),
		];
		const results = gradeTranscript(messages);
		assert.deepEqual(failing(results), ["one-active-problem"]);
		assert.match(evidenceOf(results, "one-active-problem"), /no problem open \(the tool refused it\)/);
	});
});

describe("conclude-gate", () => {
	/** 0-4 posed, 5 his input, 6-7 concluded, 8 the tutor's reveal. */
	const ended = (input: LhMessage, outcome = "surrendered") => [
		ctx(),
		newUserMessage(OPENING),
		tutor(WARM_UP),
		...pose("call_p1", SOCKS),
		input,
		...conclude("call_c1", outcome),
		tutor("Here is how it goes."),
	];

	it("flags giving up on his behalf, quoting his last message", () => {
		const results = gradeTranscript(ended(newThinkingMessage("call_p1", "Two socks?")));
		assert.deepEqual(failing(results), ["conclude-gate"]);
		assert.match(evidenceOf(results, "conclude-gate"), /his last message: "Two socks\?"/);
	});

	it("passes when he asked to end it, straight or curly apostrophe", () => {
		for (const text of ["I give up, show me the answer.", "I’m done with this one."]) {
			const results = gradeTranscript(ended(newUserMessage(text)));
			assert.deepEqual(failing(results), [], text);
		}
	});

	it("flags crediting a problem before he submitted anything", () => {
		const messages = [
			ctx(),
			newUserMessage(OPENING),
			tutor(WARM_UP),
			...pose("call_p1", SOCKS),
			...conclude("call_c1", "solved"),
			tutor(WRAP),
		];
		const results = gradeTranscript(messages);
		assert.deepEqual(failing(results), ["conclude-gate"]);
		assert.match(evidenceOf(results, "conclude-gate"), /before the learner submitted anything/);
	});

	it("flags a dismissal the tutor wrote itself", () => {
		const results = gradeTranscript(ended(newThinkingMessage("call_p1", "Two socks?"), "dismissed"));
		assert.deepEqual(failing(results), ["conclude-gate"]);
		assert.match(evidenceOf(results, "conclude-gate"), /outcome "dismissed"/);
	});
});

describe("pause-law", () => {
	it("flags the next problem after a message that does not ask for one", () => {
		const messages = lesson();
		messages[11] = newUserMessage("Thanks, that makes sense.");
		const results = gradeTranscript(messages);
		assert.deepEqual(failing(results), ["pause-law"]);
		assert.match(evidenceOf(results, "pause-law"), /does not ask for one/);
	});

	it("flags the next problem posed in the same reply as the conclusion, once", () => {
		const messages = [
			ctx(),
			newUserMessage(OPENING),
			tutor(WARM_UP),
			...pose("call_p1", SOCKS),
			newThinkingMessage("call_p1", FINAL),
			calls([
				{ id: "call_c1", name: PRACTICE_CONCLUDE_TOOL, args: { outcome: "solved", verdict: "Clean work." } },
				{ id: "call_p2", name: PRACTICE_PROBLEM_TOOL, args: CARDS },
			]),
			ack("call_c1", PRACTICE_CONCLUDE_TOOL),
			ack("call_p2", PRACTICE_PROBLEM_TOOL),
		];
		const results = gradeTranscript(messages);
		assert.deepEqual(failing(results), ["pause-law"]);
		const { findings } = grader(results, "pause-law");
		assert.equal(findings.length, 1);
		assert.match(findings[0]?.evidence ?? "", /same turn as the conclusion/);
	});

	it("lets the tutor speak after concluding, through send_to_user too", () => {
		const messages = [
			...practiceRun([]),
			call("call_s1", SEND_TO_USER_TOOL, { message: "Nice work. Say when you want another." }),
			ack("call_s1", SEND_TO_USER_TOOL),
		];
		assert.deepEqual(failing(gradeTranscript(messages)), []);
	});

	it("flags any other tool called after concluding, in the same turn", () => {
		const messages = [...practiceRun([]), call("call_r1", "read", { path: "notes.md" }), ack("call_r1", "read")];
		const results = gradeTranscript(messages);
		assert.deepEqual(failing(results), ["pause-law"]);
		assert.match(evidenceOf(results, "pause-law"), /Called read after concluding, in the same turn\./);
	});
});

describe("no-leak and one-rung-per-request", () => {
	it("three small hints that add up to most of the solution leak it, though no single one is too big", () => {
		const results = gradeTranscript(
			practiceRun([
				"Treat the two colors as boxes and the socks as items.",
				"Two socks can still be one of each color.",
				"A third sock must repeat a color.",
			]),
		);
		assert.deepEqual(failing(results), ["no-leak"]);
		assert.match(evidenceOf(results, "no-leak"), /said 58% of what the learner had not yet found/);
	});

	it("saying the solution's conclusion before he found it leaks it, however little else was said", () => {
		const results = gradeTranscript(
			practiceRun(["Think of it this way: a third sock must repeat a color, so three socks guarantee a matching pair."]),
		);
		assert.deepEqual(failing(results), ["no-leak"]);
		assert.match(evidenceOf(results, "no-leak"), /conclusion/);
	});

	it("one hint carrying two fifths of the solution is too big a rung, though nothing leaked", () => {
		const results = gradeTranscript(practiceRun(["Treat the two colors as boxes and the socks as items. Two socks can still be"]));
		assert.deepEqual(failing(results), ["one-rung-per-request"]);
		assert.match(evidenceOf(results, "one-rung-per-request"), /gave away 42% of the committed solution/);
	});

	it("reciting the whole solution as a hint breaks both", () => {
		const results = gradeTranscript(practiceRun([SOCKS.modelSolution]));
		assert.deepEqual(failing(results), ["no-leak", "one-rung-per-request"]);
	});

	it("a hint the session never needed: the rung grader does not apply", () => {
		const results = gradeTranscript(practiceRun([]));
		assert.equal(grader(results, "one-rung-per-request").applicable, false);
		assert.equal(grader(results, "no-leak").applicable, true);
		assert.deepEqual(failing(results), []);
	});
});

describe("never-announce", () => {
	it("flags naming the target in the problem statement", () => {
		const statement = `Use the pigeonhole principle: a${SOCKS.statement.slice(1)}`;
		const results = gradeTranscript(practiceRun([], { poseInput: { ...SOCKS, statement } }));
		assert.deepEqual(failing(results), ["never-announce"]);
		assert.match(evidenceOf(results, "never-announce"), /in the problem statement/);
	});

	it("flags naming it in the words posing the problem", () => {
		const results = gradeTranscript(practiceRun([], { warmUp: "Here is a pigeonhole principle warm-up." }));
		assert.deepEqual(failing(results), ["never-announce"]);
		assert.match(evidenceOf(results, "never-announce"), /in the words posing the problem/);
	});

	it("lets a hint name it once he is working", () => {
		assert.deepEqual(failing(gradeTranscript(practiceRun(["Think about the pigeonhole principle."]))), []);
	});

	it("does not apply to a name too short to test, or a target outside the picks", () => {
		for (const messages of [
			practiceRun([], { picks: [{ ...PIGEONHOLE, name: "Boxes" }] }),
			practiceRun([], { poseInput: { ...SOCKS, target: ["n_unknown"] } }),
		]) {
			const result = grader(gradeTranscript(messages), "never-announce");
			assert.equal(result.applicable, false);
			assert.equal(result.pass, true);
		}
	});
});

describe("verdict-honesty", () => {
	it("flags a credited problem the answer check judged wrong, at the conclude call", () => {
		const results = gradeTranscript(lesson(), {
			assessments: [assessment("call_c1", "call_p1"), assessment("call_c2", "call_p2", false)],
		});
		assert.deepEqual(failing(results), ["verdict-honesty"]);
		const { findings } = grader(results, "verdict-honesty");
		assert.equal(findings.length, 1);
		assert.equal(findings[0]?.at, 15);
		assert.match(findings[0]?.evidence ?? "", /Concluded "solved", but the answer check judged/);
	});

	it("does not apply without the answer check's log", () => {
		const result = grader(gradeTranscript(lesson()), "verdict-honesty");
		assert.equal(result.applicable, false);
		assert.equal(result.pass, true);
	});
});

// ─── 2. the outline ──────────────────────────────────────────────────────────

describe("transcriptOutline (the session as numbered lines)", () => {
	it("says who said what, with the pose's committed solution and the conclusion spelled out", () => {
		const outline = transcriptOutline(lesson());
		for (const line of [
			"[0] Session context: practicing Pigeonhole principle",
			`[1] Learner: ${OPENING}`,
			"[3] Tutor posed a problem: A drawer holds 5 red socks",
			"| committed solution: Treat the two colors as boxes",
			"[5] Learner (submission): Two socks?",
			"[8] Tutor concluded: solved | verdict: Clean work.",
			"[11] Learner: [Next problem]",
		]) {
			assert.ok(outline.includes(line), `has "${line}" in:\n${outline}`);
		}
		assert.ok(!outline.includes("[4]"), "a clean ack adds no line");
	});

	it("shows the rung, a refusal, a dismissal, send_to_user as speech, and other tools by name", () => {
		const outline = transcriptOutline([
			...pose("call_p1", SOCKS),
			newThinkingMessage("call_p1", FINAL),
			...conclude("call_c1", "solvedWithHints", { extra: { rung: "R2" } }),
			call("call_s1", SEND_TO_USER_TOOL, { message: "Nice work. Say when you want another." }),
			ack("call_s1", SEND_TO_USER_TOOL),
			call("call_r1", "read", { path: "notes.md" }),
			ack("call_r1", "read"),
			...pose("call_p2", CARDS, true),
			...pose("call_p3", CARDS),
			newProblemDismissedMarker("call_p3"),
			...concludedByDismissalPair("call_p3"),
		]);
		assert.ok(outline.includes("Tutor concluded: solvedWithHints | verdict: Clean work. | hint rung: R2"));
		assert.ok(outline.includes("Tutor: Nice work. Say when you want another."));
		assert.ok(!outline.includes("Tutor called send_to_user"));
		assert.ok(outline.includes("Tutor called read"));
		assert.ok(outline.includes("The problem tool refused: Refused."));
		assert.ok(outline.includes("Learner dismissed the problem."));
		assert.ok(outline.includes("Dismissal recorded: dismissed"));
	});
});

// ─── 3. the synthetic learners ───────────────────────────────────────────────

/** Play a learner on the open socks problem until he stops. */
function playOn(kind: Parameters<typeof syntheticLearner>[0]): string[] {
	const learner = syntheticLearner(kind);
	const messages: LhMessage[] = [ctx(), newUserMessage(LEARNER_OPENING), tutor(WARM_UP), ...pose("call_p1", SOCKS)];
	const said: string[] = [];
	for (let input = learner.next(messages); input !== null; input = learner.next(messages)) {
		if (input.type !== "thinking") assert.fail(`expected thinking, got ${input.type}`);
		assert.equal(input.problemCallId, "call_p1");
		said.push(input.text);
		messages.push(newThinkingMessage("call_p1", input.text), tutor("Look again."));
		if (said.length > 10) assert.fail("the learner never stops");
	}
	return said;
}

describe("syntheticLearner", () => {
	it("the careless learner slips, fixes it, asks, then waits", () => {
		assert.deepEqual(playOn("careless"), [
			slipOf(SOCKS.modelSolution),
			`Oops, careless slip — fixed: ${SOCKS.modelSolution}`,
			"Is that right now?",
		]);
	});

	it("the confused learner tries four times, asking to give up on the way; the overconfident one opens with a slip", () => {
		const confused = playOn("confused");
		assert.equal(confused.length, 4);
		assert.ok(confused.some((line) => /give up/i.test(line)));
		const overconfident = playOn("overconfident");
		assert.equal(overconfident[0], `Easy. ${slipOf(SOCKS.modelSolution)}`);
	});

	it("asks for the next problem after a conclusion, and stops after two", () => {
		assert.deepEqual(syntheticLearner("careless").next(lesson().slice(0, 11)), { type: "next" });
		assert.equal(syntheticLearner("careless").next(lesson()), null);
	});

	it("nudges once when the tutor answers without posing, then stops", () => {
		const learner = syntheticLearner("confused");
		const messages: LhMessage[] = [ctx(), newUserMessage(LEARNER_OPENING), tutor("What would you like to practice?")];
		assert.deepEqual(learner.next(messages), { type: "text", text: ASK_FOR_PROBLEM });
		messages.push(newUserMessage(ASK_FOR_PROBLEM), tutor("In a moment."));
		assert.equal(learner.next(messages), null);
	});

	it("stops at the input cap", () => {
		const chatter = (n: number): LhMessage[] => [ctx(), ...Array.from({ length: n }, (_, i) => newUserMessage(`Hello ${i + 1}`))];
		assert.deepEqual(syntheticLearner("careless").next(chatter(MAX_LEARNER_INPUTS - 1)), { type: "text", text: ASK_FOR_PROBLEM });
		assert.equal(syntheticLearner("careless").next(chatter(MAX_LEARNER_INPUTS)), null);
	});
});

describe("slipOf (a plausible wrong version of a solution)", () => {
	it("bumps the last digit, else flips a polarity word, else negates, else drops the last sentence, else halves", () => {
		assert.equal(slipOf("Five pairs of 11 make 55."), "Five pairs of 11 make 56.");
		assert.equal(slipOf("The posterior increases."), "The posterior decreases.");
		assert.equal(slipOf("Always pair the ends."), "Never pair the ends.");
		assert.equal(slipOf("The set is finite."), "The set is not finite.");
		assert.equal(slipOf("The set is not finite."), "The set is finite.");
		assert.equal(slipOf("Pair the ends. Count them."), "Pair the ends.");
		assert.equal(slipOf("Pair the ends and count them"), "Pair the ends …");
		assert.equal(slipOf(""), "I think it's the opposite.");
		assert.equal(slipOf("   "), "I think it's the opposite.");
		assert.equal(slipOf(SOCKS.modelSolution), "Treat the two colors as boxes and the socks as items. Two socks can still be one of each color.");
		assert.equal(slipOf(CARDS.modelSolution), "The four suits are the boxes and the cards are the items. Four cards can all differ in suit.");
	});

	it("never returns its input", () => {
		for (const text of ["9", "x", "Is it?", "odd", "It is.", "A. B.", "Pair 1 with 10.", SOCKS.modelSolution, CARDS.modelSolution]) {
			assert.notEqual(slipOf(text), text, text);
		}
	});
});

// ─── 4. the rubric judge ─────────────────────────────────────────────────────

function rubricStep(args: Record<string, unknown>, onCall?: (context: unknown) => void): FauxResponseStep {
	return (context) => {
		onCall?.(context);
		return fauxAssistantMessage([fauxToolCall(RUBRIC_TOOL, args as ToolCall["arguments"], { id: `rubric-${++seq}` })], {
			stopReason: "toolUse",
		});
	};
}

const SCORES = { diagnosis: 4, hints: 3, feedback: 5, pacing: 4 };

describe("runTutorRubric (the opt-in judge, scripted)", () => {
	it("returns the four scores and the trimmed summary with its usage; it read the outline under the rubric", async () => {
		let seen = { system: "", user: "" };
		const engine = fauxEngine([rubricStep({ ...SCORES, summary: "  Line 6 aimed at his error.  " }, (c) => (seen = seenBy(c)))]);
		const result = await runTutorRubric(transcriptOutline(lesson()), { engine });
		assert.deepEqual(result.scores, SCORES);
		assert.equal(result.summary, "Line 6 aimed at his error.");
		assert.equal(result.steps.length, 1);
		assert.match(result.model ?? "", /^[^:]+:.+/);
		assert.ok(seen.system.includes(RUBRIC_INSTRUCTIONS.slice(0, 60)));
		assert.ok(seen.user.includes("Session context: practicing Pigeonhole principle"));
	});

	it("a score off the scale, or an empty summary, is refused and the model tries again", async () => {
		for (const bad of [{ ...SCORES, diagnosis: 6, summary: "Fine." }, { ...SCORES, summary: "   " }]) {
			const engine = fauxEngine([rubricStep(bad), rubricStep({ ...SCORES, summary: "Fine." })]);
			const result = await runTutorRubric("[0] Learner: hi", { engine });
			assert.deepEqual(result.scores, SCORES);
			assert.equal(result.steps.length, 2, "both calls are paid for");
		}
	});

	it("throws when the model never submits", async () => {
		const engine = fauxEngine([fauxAssistantMessage("The tutor did well.", { stopReason: "stop" })]);
		await assert.rejects(runTutorRubric("[0] Learner: hi", { engine }), /never submitted scores/);
	});
});

// ─── 5. the eval command ─────────────────────────────────────────────────────

describe("the eval command (scripts/evals.ts)", () => {
	const folders: string[] = [];
	after(() => {
		for (const dir of folders) fs.rmSync(dir, { recursive: true, force: true });
	});

	function folder(files: Record<string, string>): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-evals-test-"));
		folders.push(dir);
		for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
		return dir;
	}

	const recording = (messages: LhMessage[], assessments?: PracticeAssessment[]) =>
		JSON.stringify({
			version: RECORD_VERSION,
			learner: "careless",
			model: { provider: "copilot", id: "test-model" },
			recordedAt: AT,
			messages,
			...(assessments ? { assessments } : {}),
		});

	it("parseRecorded names the file and the fault, and defaults the answer checks to none", () => {
		const good = { version: RECORD_VERSION, learner: "careless", model: { provider: "copilot", id: "m" }, recordedAt: AT, messages: [] };
		const broken: ReadonlyArray<[string, RegExp]> = [
			["{", /not JSON/],
			["[]", /not a JSON object/],
			[JSON.stringify({ ...good, version: 2 }), /version must be 1/],
			[JSON.stringify({ ...good, learner: "lazy" }), /learner must be one of confused, overconfident, careless/],
			[JSON.stringify({ ...good, model: "m" }), /model must be/],
			[JSON.stringify({ ...good, messages: {} }), /messages must be an array/],
			[JSON.stringify({ ...good, messages: [{}] }), /every message needs a role/],
		];
		for (const [text, why] of broken) {
			const parsed = parseRecorded(text, "t.json");
			assert.ok(!parsed.ok, text);
			assert.ok(parsed.error.startsWith("t.json: "), parsed.error);
			assert.match(parsed.error, why);
		}
		const parsed = parseRecorded(JSON.stringify(good), "t.json");
		assert.ok(parsed.ok);
		assert.deepEqual(parsed.session.assessments, []);
	});

	it("grades every transcript in a folder, reports the broken ones, ignores other files, and prints ASCII", () => {
		const dir = folder({ "good.json": recording(lesson(), agreeing()), "bad.json": "{", "notes.txt": "not a transcript" });
		const { rows, errors } = gradeRecordedDir(dir);
		assert.deepEqual(rows.map((r) => r.file), ["good.json"]);
		assert.ok(transcriptPasses(rows[0]?.results ?? []));
		assert.equal(errors.length, 1);
		assert.match(errors[0] ?? "", /^bad\.json: not JSON/);
		const report = formatReport(rows, errors);
		assert.ok(report.endsWith("1 transcript: 1 passed, 0 failed; 1 could not be graded."), report);
		assert.match(report, /^[\x20-\x7E\n]*$/, "plain ASCII");
	});

	it("ascii spells typography out; file names keep to safe characters", () => {
		assert.equal(ascii("a… ‘b’ “c” — d – e"), "a... 'b' \"c\" -- d - e");
		assert.equal(sessionFileName("confused", "gpt 5/mini"), "confused-gpt-5-mini.json");
	});

	it("parseArgs refuses what it cannot run", () => {
		const cases: ReadonlyArray<[string[], string]> = [
			[["--help=x"], "--help takes no value"],
			[["--x"], "unknown option --x"],
			[["x"], 'unexpected argument "x"'],
			[["--dir"], "--dir needs a value"],
			[["--dir", "--live"], "--dir needs a value"],
			[["--live", "--learners", "x"], 'unknown learner "x" (one of confused, overconfident, careless)'],
			[["--live", "--learners=,"], "--learners needs at least one learner"],
			[["--model", "x"], "--model needs --live"],
			[["--live", "--dir", "d"], "--dir grades recorded transcripts; it cannot be combined with --live"],
		];
		for (const [argv, error] of cases) assert.deepEqual(parseArgs(argv), { ok: false, error }, argv.join(" "));
	});

	it("parseArgs merges and dedupes the models and defaults to every learner", () => {
		const parsed = parseArgs(["--live", "--model", "a,b", "--models=b,c", "--rubric"]);
		assert.ok(parsed.ok);
		assert.deepEqual(parsed.args.models, ["a", "b", "c"]);
		assert.deepEqual(parsed.args.learners, ["confused", "overconfident", "careless"]);
		assert.equal(parsed.args.rubric, true);
	});

	it("main: 0 when every transcript passes, 1 on a failure or an empty folder, 2 on bad arguments or --live under tests", async (t) => {
		const log = t.mock.method(console, "log", () => {});
		t.mock.method(console, "error", () => {});
		assert.equal(await main(["--help"]), 0);
		assert.equal(await main(["--bogus"]), 2);
		assert.equal(await main(["--live", "--model", "x"]), 2);
		assert.equal(await main(["--dir", folder({ "good.json": recording(lesson(), agreeing()) })]), 0);
		const credited = [assessment("call_c1", "call_p1"), assessment("call_c2", "call_p2", false)];
		assert.equal(await main(["--dir", folder({ "bad.json": recording(lesson(), credited) })]), 1);
		log.mock.resetCalls();
		assert.equal(await main(["--dir", folder({})]), 1);
		assert.ok(log.mock.calls.some((c) => String(c.arguments[0]).includes("no transcripts")));
	});
});

// ─── 6. whole eval sessions ──────────────────────────────────────────────────

/** The connection gate under tests opens for a Copilot pin. */
const PINNED = { provider: "copilot", id: "claude-haiku-4.5" };
const RIGHT: AssessorResult = { judgment: "correct", reason: "Right.", steps: [] };
const WRONG: AssessorResult = { judgment: "incorrect", reason: "He left out a case.", steps: [] };

/** The practice agent on a scripted engine, rebuilt per turn like the handler's own. */
function scriptedTutor(steps: FauxResponseStep[]): NonNullable<EvalSessionOptions["buildAgent"]> {
	const engine = fauxEngine(steps);
	return (opts) => createPracticeAgent({ chatId: opts.chatId!, chatStore: stores.chatStore }, { engine, messages: opts.messages });
}

const poseStep = (id: string, input: ToolCall["arguments"]): FauxResponseStep => () =>
	fauxAssistantMessage([fauxToolCall(PRACTICE_PROBLEM_TOOL, input, { id })], { stopReason: "toolUse" });

const concludeStep = (id: string, verdict: string): FauxResponseStep => () =>
	fauxAssistantMessage(
		[fauxToolCall(PRACTICE_CONCLUDE_TOOL, { outcome: "solved", verdict, rung: null, missClass: null, retest: false }, { id })],
		{ stopReason: "toolUse" },
	);

const sayStep = (text: string): FauxResponseStep => () => fauxAssistantMessage(text, { stopReason: "stop" });

describe("runEvalSession (a whole session through the chat handler, scripted)", () => {
	it("a careless learner and a tutor that keeps the laws: every grader applies and passes", async () => {
		const checked: AssessmentInput[] = [];
		const session = await runEvalSession({
			learner: syntheticLearner("careless"),
			model: PINNED,
			picks: [PIGEONHOLE],
			buildAgent: scriptedTutor([
				poseStep("call_p1", SOCKS),
				sayStep("Close. Look again at what you left out."),
				concludeStep("call_c1", "Right: the worst case forces a third sock."),
				sayStep("Well done. Say when you want another."),
				poseStep("call_p2", CARDS),
				sayStep("Close. Look again at what you left out."),
				concludeStep("call_c2", "Right: the fifth card must repeat a suit."),
				sayStep("That is the pattern."),
			]),
			assess: async (input) => {
				checked.push(input);
				return RIGHT;
			},
		});
		assert.equal(session.error, undefined);
		assert.equal(session.learner, "careless");
		assert.equal(session.assessments.length, 2);
		assert.ok(session.assessments.every((a) => a.agrees));
		for (const r of session.results) {
			assert.ok(r.applicable, `${r.id} applies`);
			assert.ok(r.pass, `${r.id} passes: ${JSON.stringify(r.findings)}`);
		}
		assert.deepEqual(
			checked.map((c) => c.answers),
			[
				[slipOf(SOCKS.modelSolution), `Oops, careless slip — fixed: ${SOCKS.modelSolution}`],
				[slipOf(CARDS.modelSolution), `Oops, careless slip — fixed: ${CARDS.modelSolution}`],
			],
			"the check saw his slip and his fix, never the hint",
		);
	});

	it("a tutor that credits his slips fails verdict honesty, once per problem", async () => {
		const session = await runEvalSession({
			learner: syntheticLearner("careless"),
			model: PINNED,
			picks: [PIGEONHOLE],
			buildAgent: scriptedTutor([
				poseStep("call_p1", SOCKS),
				concludeStep("call_c1", "Correct."),
				sayStep("Say when you want another."),
				poseStep("call_p2", CARDS),
				concludeStep("call_c2", "Correct."),
				sayStep("That is the pattern."),
			]),
			assess: async () => WRONG,
		});
		assert.equal(session.error, undefined);
		assert.deepEqual(failing(session.results), ["verdict-honesty"]);
		assert.equal(grader(session.results, "verdict-honesty").findings.length, 2);
	});

	it("stops at the turn cap with the learner still playing, and says so", async () => {
		const session = await runEvalSession({
			learner: syntheticLearner("careless"),
			model: PINNED,
			picks: [PIGEONHOLE],
			maxTurns: 1,
			buildAgent: scriptedTutor([poseStep("call_p1", SOCKS)]),
			assess: async () => assert.fail("nothing was concluded"),
		});
		assert.match(session.error ?? "", /Stopped after 1 turns/);
	});
});
