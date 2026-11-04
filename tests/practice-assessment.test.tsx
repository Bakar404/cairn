/**
 * THE ANSWER CHECK (M24): after a practice problem concludes, a second
 * model grades the learner's answer without seeing the tutor's outcome,
 * verdict or hints, and the conclude card flags a disagreement. All
 * deterministic, with no network:
 *
 *   1. the input: the learner's own submissions only, and what is never
 *      checked (surrendered, dismissed, errored, unreadable, moved on
 *      without an answer)
 *   2. the prompt: blind to the tutor's outcome and verdict; capped and
 *      clipped
 *   3. the agreement table and the unanswered entry
 *   4. the assessor run against a scripted faux engine
 *   5. the trigger against the real chat store: a wrong answer the tutor
 *      marked solved is flagged and a correct one is not; the switch,
 *      idempotence, the in-flight guard and the failure paths
 *   6. the record: the idempotent append and the list payload
 *   7. the card: the flag on a disagreement only; the client's adoption
 *   8. the Settings switch
 */

import "./isolated-data-dir.ts";
import React from "react";
(globalThis as Record<string, unknown>).React = React; // tsx classic-JSX shim (see render-cards.test.tsx)

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
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

import { AssessmentsContext } from "../components/assessments-context.ts";
import { adoptAssessments } from "../components/chat.tsx";
import { ConcludeCard } from "../components/practice-cards.tsx";
import { AgentSection, composeAssessor } from "../components/settings/agent-section.tsx";
import type { PiEngine } from "../src/agent/models.ts";
import { ASSESS_TOOL, ASSESSOR_INSTRUCTIONS, runAssessor, type AssessorResult } from "../src/agent/subagents/assessor.ts";
import type { ArtifactPartProps } from "../src/core";
import type { AssessorJudgment, PracticeAssessment } from "../src/core/contracts.ts";
import { subscribe } from "../src/core/events.ts";
import {
	newThinkingMessage,
	newUserMessage,
	problemCallForConclude,
	PRACTICE_CONCLUDE_TOOL,
	PRACTICE_PROBLEM_TOOL,
	type LhMessage,
} from "../src/core/native-messages.ts";
import {
	ASSESSOR_MAX_SUBMISSION_CHARS,
	ASSESSOR_MAX_SUBMISSIONS,
	assessmentAgrees,
	assessmentInputFor,
	buildAssessorPrompt,
	concludeCallIdsOf,
	unansweredAssessment,
	type AssessmentInput,
} from "../src/core/practice-assessment.ts";
import { sanitizeUserSettings, type AgentSettings } from "../src/core/settings.ts";
import { assessorEnabled, resolveSettings } from "../src/core/settings-resolution.ts";
import { triggerAssessments } from "../src/server/practice-assessment.ts";
import { parseAgentSettingsBody } from "../src/server/settings-body.ts";
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

const PROBLEM = {
	statement: "What is the sum of the whole numbers from 1 to 10?",
	mode: "recall",
	modelSolution: "Pair 1 with 10, 2 with 9, and so on: five pairs of 11 make 55.",
};

const AT = "2026-11-02T12:00:00.000Z";

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

/** The tutor posing a problem, with its clean ack. */
function pose(callId = "call_p1", input: ToolCall["arguments"] = PROBLEM, refused = false): LhMessage[] {
	return [call(callId, PRACTICE_PROBLEM_TOOL, input), ack(callId, PRACTICE_PROBLEM_TOOL, refused)];
}

/** The tutor concluding it. The ack must be clean: an errored conclude
 *  never happened. */
function conclude(callId: string, outcome: string, verdict = "Clean work.", errored = false): LhMessage[] {
	return [call(callId, PRACTICE_CONCLUDE_TOOL, { outcome, verdict }), ack(callId, PRACTICE_CONCLUDE_TOOL, errored)];
}

/** The tutor talking (a hint, a nudge). */
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

/** A learner message carrying an image (the check cannot read it). */
function imageMessage(): LhMessage {
	return { ...newUserMessage(""), content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] };
}

function entry(over: Partial<PracticeAssessment> = {}): PracticeAssessment {
	return {
		concludeCallId: "call_c1",
		problemCallId: "call_p1",
		at: AT,
		outcome: "solved",
		judgment: "incorrect",
		reason: "He summed to 45, not 55.",
		agrees: false,
		model: "test:cheap-model",
		steps: [],
		...over,
	};
}

/** A scripted pi engine (faux provider): the response queue is the model. */
function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

function submitStep(judgment: string, reason: string, onCall?: (context: unknown) => void): FauxResponseStep {
	return (context) => {
		onCall?.(context);
		return fauxAssistantMessage(
			[fauxToolCall(ASSESS_TOOL, { judgment, reason } as ToolCall["arguments"], { id: `assess-${++seq}` })],
			{ stopReason: "toolUse" },
		);
	};
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

// ─── 1. the input ────────────────────────────────────────────────────────────

describe("assessmentInputFor (the learner's own submissions, nothing else)", () => {
	it("collects his thinking for this problem and what he typed, oldest first; never the tutor's words", () => {
		const typed: LhMessage = { ...newUserMessage(""), content: [{ type: "text", text: "So it is" }, { type: "text", text: "55." }] };
		const messages = [
			...pose(),
			newThinkingMessage("call_p1", "  1 + 2 + … + 10: pair them up  "),
			tutor("Hint: try pairing the ends."),
			newThinkingMessage("call_other", "an answer to some other problem"),
			newThinkingMessage("call_p1", "   "),
			typed,
			...conclude("call_c1", "solvedWithHints", "The pairing came after a hint."),
		];
		assert.deepEqual(assessmentInputFor(messages, "call_c1"), {
			concludeCallId: "call_c1",
			problemCallId: "call_p1",
			outcome: "solvedWithHints",
			statement: PROBLEM.statement,
			modelSolution: PROBLEM.modelSolution,
			mode: "recall",
			answers: ["1 + 2 + … + 10: pair them up", "So it is\n55."],
		});
	});

	it("checks nothing it cannot test", () => {
		const answered = [newThinkingMessage("call_p1", "55")];
		const run = (outcome: string, between: LhMessage[] = answered) =>
			assessmentInputFor([...pose(), ...between, ...conclude("call_c1", outcome)], "call_c1");
		assert.equal(run("surrendered"), null, "a surrender claims nothing about an answer");
		assert.equal(run("dismissed"), null, "nor does a dismissal");
		assert.equal(run("movedOn", []), null, "moved on with no answer: nothing to grade");
		assert.ok(run("movedOn"), "moved on after an answer: the check can test that it was not correct");
		assert.deepEqual(run("solved", [])?.answers, [], "credited with no answer: the unanswered entry");
		assert.equal(run("solved", [imageMessage()]), null, "an image the check cannot read");
		assert.equal(
			assessmentInputFor([...pose(), ...answered, ...conclude("call_c1", "solved", "v", true)], "call_c1"),
			null,
			"an errored conclude never happened",
		);
		assert.equal(assessmentInputFor([...pose(), ...answered, ...conclude("call_c1", "solved")], "call_unknown"), null);
		assert.equal(
			assessmentInputFor([...pose("call_p1", PROBLEM, true), ...answered, ...conclude("call_c1", "solved")], "call_c1"),
			null,
			"a refused pose posed nothing",
		);
		const without = (field: "statement" | "modelSolution") => {
			const input: ToolCall["arguments"] = { ...PROBLEM };
			delete input[field];
			return assessmentInputFor([...pose("call_p1", input), ...answered, ...conclude("call_c1", "solved")], "call_c1");
		};
		assert.equal(without("statement"), null, "no statement");
		assert.equal(without("modelSolution"), null, "no committed solution to grade against");
	});

	it("a conclude closes the problem posed BEFORE it, even when the next pose rides the same message", () => {
		const both: LhMessage & AssistantMessage = {
			id: "msg_both",
			role: "assistant",
			content: [
				{ type: "toolCall", id: "call_c1", name: PRACTICE_CONCLUDE_TOOL, arguments: { outcome: "solved", verdict: "v" } },
				{ type: "toolCall", id: "call_p2", name: PRACTICE_PROBLEM_TOOL, arguments: { statement: "Next", modelSolution: "N" } },
			],
			timestamp: 3,
			...STAMPS,
		};
		const messages = [
			...pose(),
			newThinkingMessage("call_p1", "55"),
			both,
			ack("call_c1", PRACTICE_CONCLUDE_TOOL),
			ack("call_p2", PRACTICE_PROBLEM_TOOL),
		];
		assert.equal(problemCallForConclude(messages, "call_c1")?.toolCallId, "call_p1");
		assert.equal(assessmentInputFor(messages, "call_c1")?.statement, PROBLEM.statement, "never the next problem's");
	});

	it("concludeCallIdsOf lists the conclude calls in order", () => {
		const messages = [
			...pose(),
			...conclude("call_c1", "solved"),
			...pose("call_p2"),
			tutor("Next one."),
			...conclude("call_c2", "movedOn"),
		];
		assert.deepEqual(concludeCallIdsOf(messages), ["call_c1", "call_c2"]);
		assert.deepEqual(concludeCallIdsOf([]), []);
	});
});

// ─── 2. the prompt ───────────────────────────────────────────────────────────

describe("buildAssessorPrompt (blind, capped, clipped)", () => {
	const input = (answers: string[], over: Partial<AssessmentInput> = {}): AssessmentInput => ({
		concludeCallId: "call_c1",
		problemCallId: "call_p1",
		outcome: "solved",
		statement: PROBLEM.statement,
		modelSolution: PROBLEM.modelSolution,
		mode: "recall",
		answers,
		...over,
	});

	it("carries the problem, the committed solution and his submissions, the last marked final; never the outcome or verdict", () => {
		const messages = [
			...pose(),
			newThinkingMessage("call_p1", "pair them"),
			tutor("HINT-MARKER: look at the ends"),
			newUserMessage("55"),
			...conclude("call_c1", "solvedWithHints", "VERDICT-MARKER: clean after R2"),
		];
		const prompt = buildAssessorPrompt(assessmentInputFor(messages, "call_c1")!);
		assert.ok(prompt.includes(`## Problem\n\n${PROBLEM.statement}`));
		assert.ok(prompt.includes("## Mode\n\nrecall"));
		assert.ok(prompt.includes(`## Reference solution\n\n${PROBLEM.modelSolution}`));
		assert.ok(prompt.includes("### Submission 1\n\npair them"));
		assert.ok(prompt.includes("### Submission 2 (final)\n\n55"));
		assert.ok(!prompt.includes("VERDICT-MARKER"), "the verdict stays out");
		assert.ok(!prompt.includes("HINT-MARKER"), "so do the hints");
		assert.doesNotMatch(prompt, /solved|hints?\b|R2/i, "and the outcome");
		assert.ok(!buildAssessorPrompt(input(["x"], { mode: undefined })).includes("## Mode"), "no mode, no section");
	});

	it("keeps the newest submissions and says how many it left out", () => {
		const letters = "ABCDEFGHIJKLMNOP".split("").slice(0, ASSESSOR_MAX_SUBMISSIONS + 2);
		const prompt = buildAssessorPrompt(input(letters.map((l) => `answer ${l}`)));
		assert.ok(prompt.includes("(2 earlier submissions omitted)"));
		assert.ok(!prompt.includes("answer A") && !prompt.includes("answer B"));
		assert.ok(prompt.includes("### Submission 3\n\nanswer C"), "numbering keeps counting from the first");
		assert.ok(prompt.includes(`### Submission ${letters.length} (final)\n\nanswer ${letters.at(-1)}`));
		const one = buildAssessorPrompt(input(letters.slice(0, ASSESSOR_MAX_SUBMISSIONS + 1)));
		assert.ok(one.includes("(1 earlier submission omitted)"));
		assert.ok(!buildAssessorPrompt(input(letters.slice(0, ASSESSOR_MAX_SUBMISSIONS))).includes("omitted"));
	});

	it("clips a long submission and marks the cut", () => {
		const prompt = buildAssessorPrompt(input(["x".repeat(ASSESSOR_MAX_SUBMISSION_CHARS + 50)]));
		assert.ok(prompt.includes(`${"x".repeat(ASSESSOR_MAX_SUBMISSION_CHARS)}\n[truncated]`));
		assert.ok(!prompt.includes("x".repeat(ASSESSOR_MAX_SUBMISSION_CHARS + 1)));
		assert.ok(!buildAssessorPrompt(input(["x".repeat(ASSESSOR_MAX_SUBMISSION_CHARS)])).includes("[truncated]"));
	});
});

// ─── 3. agreement ────────────────────────────────────────────────────────────

describe("assessmentAgrees and the unanswered entry", () => {
	it("a credited outcome needs a correct answer; a moved-on problem needs one that is not", () => {
		const table: [string, AssessorJudgment, boolean][] = [
			["solved", "correct", true],
			["solved", "partial", false],
			["solved", "incorrect", false],
			["solved", "unanswered", false],
			["solvedWithHints", "correct", true],
			["solvedWithHints", "partial", false],
			["solvedWithHints", "incorrect", false],
			["movedOn", "correct", false],
			["movedOn", "partial", true],
			["movedOn", "incorrect", true],
		];
		for (const [outcome, judgment, agrees] of table) {
			assert.equal(assessmentAgrees(outcome, judgment), agrees, `${outcome} × ${judgment}`);
		}
	});

	it("a credited problem with no answer is flagged, decided without a model", () => {
		const input = assessmentInputFor([...pose(), ...conclude("call_c1", "solved")], "call_c1")!;
		assert.deepEqual(unansweredAssessment(input, AT), {
			concludeCallId: "call_c1",
			problemCallId: "call_p1",
			at: AT,
			outcome: "solved",
			judgment: "unanswered",
			reason: "No answer was submitted for this problem.",
			agrees: false,
			steps: [],
		});
	});
});

// ─── 4. the assessor run ─────────────────────────────────────────────────────

describe("runAssessor (one blind submit call)", () => {
	const input = () =>
		assessmentInputFor(
			[...pose(), newThinkingMessage("call_p1", "It is 45."), ...conclude("call_c1", "solved", "VERDICT-MARKER")],
			"call_c1",
		)!;

	it("returns the model's judgment and reason with its usage; it ran under the rubric and never saw the verdict", async () => {
		let seen = { system: "", user: "" };
		const engine = fauxEngine([submitStep("incorrect", "  He summed to 45, not 55.  ", (context) => (seen = seenBy(context)))]);
		const result = await runAssessor(input(), { engine });
		assert.equal(result.judgment, "incorrect");
		assert.equal(result.reason, "He summed to 45, not 55.", "trimmed");
		assert.equal(result.steps.length, 1);
		assert.ok((result.steps[0]?.inputTokens ?? 0) > 0, "the call's usage rides along");
		assert.match(result.model ?? "", /^[^:]+:.+/, "provider-qualified");
		assert.ok(seen.system.includes(ASSESSOR_INSTRUCTIONS.slice(0, 60)));
		assert.ok(seen.user.includes("It is 45."));
		assert.ok(seen.user.includes(PROBLEM.modelSolution));
		assert.ok(!seen.user.includes("VERDICT-MARKER") && !seen.system.includes("VERDICT-MARKER"));
	});

	it("an empty reason is refused and the model tries again", async () => {
		const engine = fauxEngine([submitStep("correct", "   "), submitStep("partial", "Right pairs, wrong count.")]);
		const result = await runAssessor(input(), { engine });
		assert.equal(result.judgment, "partial");
		assert.equal(result.reason, "Right pairs, wrong count.");
		assert.equal(result.steps.length, 2, "both calls are paid for");
	});

	it("throws when the model never submits", async () => {
		const engine = fauxEngine([fauxAssistantMessage("Looks fine to me.", { stopReason: "stop" })]);
		await assert.rejects(runAssessor(input(), { engine }), /never submitted/);
	});
});

// ─── 5. the trigger ──────────────────────────────────────────────────────────

const created: string[] = [];
after(() => {
	for (const id of created) stores.chatStore.deleteChat(id);
});

function chatWith(messages: LhMessage[], kind: "practice" | "teach" = "practice"): string {
	const record = stores.chatStore.createChat("Answer check", kind === "practice" ? "practice" : undefined);
	created.push(record.id);
	stores.chatStore.saveMessages(record.id, messages);
	return record.id;
}

/** One answered problem the tutor concluded. */
function answered(answer: string, outcome = "solved", ids = { problem: "call_p1", conclude: "call_c1" }): LhMessage[] {
	return [...pose(ids.problem), newThinkingMessage(ids.problem, answer), ...conclude(ids.conclude, outcome)];
}

const WRONG: AssessorResult = { judgment: "incorrect", reason: "He summed to 45, not 55.", model: "test:cheap-model", steps: [] };
const RIGHT: AssessorResult = { judgment: "correct", reason: "Five pairs of 11 make 55.", model: "test:cheap-model", steps: [] };

/** A scripted model run that records what it was asked to grade. */
function scripted(result: AssessorResult | null | Error) {
	const calls: AssessmentInput[] = [];
	return {
		calls,
		assess: async (input: AssessmentInput) => {
			calls.push(input);
			if (result instanceof Error) throw result;
			return result;
		},
	};
}

describe("triggerAssessments (the real chat store, a scripted model)", () => {
	it("a wrong answer the tutor marked solved is flagged; a correct one is not", async () => {
		const events: string[] = [];
		const unsubscribe = subscribe((e) => {
			if (e.type === "record-changed") events.push(String(e.chatId));
		});
		try {
			const wrongChat = chatWith(answered("It is 45."));
			const wrong = scripted(WRONG);
			const flagged = await triggerAssessments(wrongChat, ["call_c1"], { assess: wrong.assess, now: () => AT });
			assert.deepEqual(flagged, [
				{
					concludeCallId: "call_c1",
					problemCallId: "call_p1",
					at: AT,
					outcome: "solved",
					judgment: "incorrect",
					reason: WRONG.reason,
					agrees: false,
					model: "test:cheap-model",
					steps: [],
				},
			]);
			assert.deepEqual(wrong.calls.map((c) => c.answers), [["It is 45."]]);
			assert.deepEqual(stores.chatStore.getChat(wrongChat)?.assessments, flagged, "written to the record");

			const rightChat = chatWith(answered("Five pairs of 11: 55."));
			const backed = await triggerAssessments(rightChat, ["call_c1"], { assess: scripted(RIGHT).assess, now: () => AT });
			assert.equal(backed.length, 1);
			assert.equal(backed[0]?.agrees, true);
			assert.equal(backed[0]?.judgment, "correct");
			assert.deepEqual(events, [wrongChat, rightChat], "each write tells an open transcript to refetch");
		} finally {
			unsubscribe();
		}
	});

	it("a moved-on problem the learner actually got right is flagged too", async () => {
		const id = chatWith(answered("55, by pairing.", "movedOn"));
		const [check] = await triggerAssessments(id, ["call_c1"], { assess: scripted(RIGHT).assess, now: () => AT });
		assert.equal(check?.outcome, "movedOn");
		assert.equal(check?.agrees, false);
	});

	it("a credited problem with no answer is flagged without a model call", async () => {
		const id = chatWith([...pose(), tutor("Nice."), ...conclude("call_c1", "solved")]);
		const model = scripted(RIGHT);
		const [check] = await triggerAssessments(id, ["call_c1"], { assess: model.assess, now: () => AT });
		assert.equal(model.calls.length, 0);
		assert.equal(check?.judgment, "unanswered");
		assert.equal(check?.agrees, false);
	});

	it("checks every conclude it is given, in order, and skips the ones with nothing to test", async () => {
		const id = chatWith([
			...answered("45", "solved"),
			...answered("I give up", "surrendered", { problem: "call_p2", conclude: "call_c2" }),
			...answered("55", "solved", { problem: "call_p3", conclude: "call_c3" }),
		]);
		const model = scripted(WRONG);
		const written = await triggerAssessments(id, ["call_c1", "call_c2", "call_c3"], { assess: model.assess, now: () => AT });
		assert.deepEqual(written.map((w) => w.concludeCallId), ["call_c1", "call_c3"]);
		assert.deepEqual(model.calls.map((c) => c.problemCallId), ["call_p1", "call_p3"]);
	});

	it("never checks the same conclude twice: neither on a second trigger nor while one is in flight", async () => {
		const id = chatWith(answered("45"));
		const first = scripted(WRONG);
		await triggerAssessments(id, ["call_c1"], { assess: first.assess, now: () => AT });
		const again = scripted(RIGHT);
		assert.deepEqual(await triggerAssessments(id, ["call_c1"], { assess: again.assess, now: () => AT }), []);
		assert.equal(again.calls.length, 0);
		assert.equal(stores.chatStore.getChat(id)?.assessments?.length, 1, "the first check stands");

		const racing = chatWith(answered("45"));
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		let calls = 0;
		const slow = async () => {
			calls++;
			await gate;
			return WRONG;
		};
		const one = triggerAssessments(racing, ["call_c1"], { assess: slow, now: () => AT });
		const two = triggerAssessments(racing, ["call_c1"], { assess: slow, now: () => AT });
		release();
		const [a, b] = await Promise.all([one, two]);
		assert.equal(calls, 1, "the second trigger saw the first in flight");
		assert.equal(a.length + b.length, 1);
		assert.equal(stores.chatStore.getChat(racing)?.assessments?.length, 1);
	});

	it("switched off in Settings: no check at all", async () => {
		const id = chatWith(answered("45"));
		const model = scripted(WRONG);
		stores.settingsStore.writeSettings({ version: 1, agent: { assessor: { enabled: false } } });
		try {
			assert.deepEqual(await triggerAssessments(id, ["call_c1"], { assess: model.assess, now: () => AT }), []);
		} finally {
			stores.settingsStore.writeSettings({ version: 1 });
		}
		assert.equal(model.calls.length, 0);
		assert.equal(stores.chatStore.getChat(id)?.assessments, undefined);
	});

	it("a teach session, a missing session, no model and a failed run write nothing and never throw", async () => {
		const model = scripted(WRONG);
		const teach = chatWith(answered("45"), "teach");
		assert.deepEqual(await triggerAssessments(teach, ["call_c1"], { assess: model.assess }), []);
		assert.deepEqual(await triggerAssessments("chat_missing", ["call_c1"], { assess: model.assess }), []);
		assert.equal(model.calls.length, 0);

		const noModel = chatWith(answered("45"));
		assert.deepEqual(await triggerAssessments(noModel, ["call_c1"], { assess: scripted(null).assess }), []);
		assert.equal(stores.chatStore.getChat(noModel)?.assessments, undefined);

		const failing = chatWith(answered("45"));
		const warn = console.warn;
		const warnings: string[] = [];
		console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
		try {
			assert.deepEqual(await triggerAssessments(failing, ["call_c1"], { assess: scripted(new Error("rate limited")).assess }), []);
		} finally {
			console.warn = warn;
		}
		assert.equal(stores.chatStore.getChat(failing)?.assessments, undefined, "a failed run is not recorded");
		assert.ok(warnings.some((w) => w.includes("rate limited")), "but it is logged");
		assert.deepEqual(await triggerAssessments(failing, [], { assess: model.assess }), []);
	});

	it("with no cheap model set up, the real run skips quietly", async () => {
		const id = chatWith(answered("45"));
		assert.deepEqual(await triggerAssessments(id, ["call_c1"]), []);
		assert.equal(stores.chatStore.getChat(id)?.assessments, undefined);
	});
});

// ─── 6. the record ───────────────────────────────────────────────────────────

describe("the record's assessments log", () => {
	it("keeps the first check of a conclude call, and stays out of the list payload", () => {
		const id = chatWith([]);
		stores.chatStore.appendAssessment(id, entry());
		stores.chatStore.appendAssessment(id, entry({ judgment: "correct", agrees: true, at: "2026-11-03T00:00:00.000Z" }));
		stores.chatStore.appendAssessment(id, entry({ concludeCallId: "call_c2" }));
		assert.deepEqual(
			stores.chatStore.getChat(id)?.assessments,
			[entry(), entry({ concludeCallId: "call_c2" })],
		);
		const summary = stores.chatStore.listChats().find((s) => s.id === id);
		assert.ok(summary);
		assert.ok(!("assessments" in summary), "the session picker never needs it");
		assert.throws(() => stores.chatStore.appendAssessment("chat_missing", entry()), /Chat not found/);
	});
});

// ─── 7. the card ─────────────────────────────────────────────────────────────

const part = (over: Partial<ArtifactPartProps["part"]>): ArtifactPartProps["part"] => ({
	type: "tool-conclude",
	state: "input-available",
	toolCallId: "call_c1",
	...over,
});

function card(assessments: Record<string, PracticeAssessment>, input: Record<string, unknown> = { outcome: "solved", verdict: "Clean." }) {
	return renderToStaticMarkup(
		<AssessmentsContext.Provider value={assessments}>
			<ConcludeCard part={part({ input, reveal: "Five pairs of 11 make 55." })} />
		</AssessmentsContext.Provider>,
	);
}

describe("the conclude card", () => {
	it("a disagreement shows the flag, under the verdict and above the solution", () => {
		const html = card({ call_c1: entry() });
		assert.ok(html.includes('data-testid="assessor-flag"'));
		assert.ok(html.includes('role="note"'));
		assert.ok(html.includes("Answer check disagrees."));
		assert.ok(html.includes("A second model graded the final answer incorrect: He summed to 45, not 55."));
		assert.ok(html.indexOf("Clean.") < html.indexOf("assessor-flag"));
		assert.ok(html.indexOf("assessor-flag") < html.indexOf("Model solution"));
		const partial = card({ call_c1: entry({ judgment: "partial", reason: "One pair short." }) });
		assert.ok(partial.includes("graded the final answer partly correct: One pair short."));
		const none = card({ call_c1: entry({ judgment: "unanswered", reason: "ignored" }) });
		assert.ok(none.includes("No answer was submitted for this problem."));
		assert.ok(!none.includes("ignored"));
	});

	it("an agreeing check stays off the card; it alone opens the metadata trigger", () => {
		const html = card({ call_c1: entry({ judgment: "correct", agrees: true }) });
		assert.ok(!html.includes("assessor-flag"));
		assert.ok(html.includes('data-testid="metadata-toggle"'));
		assert.ok(!card({}).includes("metadata-"), "no check and nothing else to show: no trigger");
	});

	it("only its own conclude's check, and never on a dismissal", () => {
		assert.ok(!card({ call_other: entry() }).includes("assessor-flag"));
		assert.ok(!card({}).includes("assessor-flag"), "no provider value: no flag");
		assert.ok(!card({ call_c1: entry() }, { outcome: "dismissed" }).includes("assessor-flag"));
		assert.ok(
			!renderToStaticMarkup(<ConcludeCard part={part({ input: { outcome: "solved" } })} />).includes("assessor-flag"),
			"outside a transcript (no provider) the card renders as before",
		);
	});

	it("adoptAssessments keeps the same object until the log changes", () => {
		const a = entry();
		const first = adoptAssessments({}, [a]);
		assert.deepEqual(Object.keys(first), ["call_c1"]);
		assert.equal(adoptAssessments(first, [{ ...a }]), first, "a refetched copy of the same log: no re-render");
		const added = adoptAssessments(first, [a, entry({ concludeCallId: "call_c2" })]);
		assert.notEqual(added, first);
		assert.deepEqual(Object.keys(added).sort(), ["call_c1", "call_c2"]);
		assert.notEqual(adoptAssessments(first, [{ ...a, at: "2026-11-03T00:00:00.000Z" }]), first, "a changed check replaces");
		const empty = {};
		assert.equal(adoptAssessments(empty, undefined), empty, "no log: unchanged");
		assert.equal(adoptAssessments(empty, []), empty);
	});
});

// ─── 8. the Settings switch ──────────────────────────────────────────────────

describe("the Answer check switch in Settings", () => {
	it("the writer accepts only { enabled: boolean }", () => {
		assert.deepEqual(parseAgentSettingsBody({ assessor: { enabled: false } }), { ok: true, settings: { assessor: { enabled: false } } });
		assert.deepEqual(parseAgentSettingsBody({ assessor: {} }), { ok: true, settings: { assessor: {} } });
		assert.deepEqual(parseAgentSettingsBody({ assessor: false }), { ok: false, error: "assessor must be an object" });
		assert.deepEqual(parseAgentSettingsBody({ assessor: { enabled: "no" } }), {
			ok: false,
			error: "assessor.enabled must be a boolean",
		});
	});

	it("the reader keeps a well-formed switch and drops a broken one; the check is on unless switched off", () => {
		const read = (assessor: unknown) => sanitizeUserSettings({ version: 1, agent: { assessor } });
		assert.deepEqual(read({ enabled: false })?.agent?.assessor, { enabled: false });
		assert.deepEqual(read({})?.agent?.assessor, {});
		assert.equal(read({ enabled: "no" })?.agent?.assessor, undefined);
		assert.equal(read([])?.agent?.assessor, undefined);
		assert.equal(assessorEnabled(resolveSettings(read({ enabled: false }))), false);
		assert.equal(assessorEnabled(resolveSettings(read({ enabled: true }))), true);
		assert.equal(assessorEnabled(resolveSettings(read({ enabled: "no" }))), true, "a broken switch falls back to on");
		assert.equal(assessorEnabled(resolveSettings(null)), true, "on by default");
	});

	it("the Agent section's row follows Microsoft Learn, is on by default, and writes its own key", () => {
		const render = (agent: AgentSettings | undefined) =>
			renderToStaticMarkup(
				<AgentSection
					agent={agent}
					models={undefined}
					graph={undefined}
					compaction={undefined}
					onSectionChange={() => {}}
					onModelsChange={() => {}}
					onCompactionChange={() => {}}
				/>,
			);
		const toggle = (html: string) => {
			const at = html.indexOf('data-testid="toggle-answer-check"');
			assert.ok(at >= 0, "the Answer check toggle");
			return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
		};
		const html = render(undefined);
		assert.ok(html.indexOf('data-testid="learn-docs-row"') < html.indexOf('data-testid="assessor-row"'));
		assert.ok(html.includes("A second model checks each practice answer and flags disagreements"));
		assert.ok(toggle(html).includes('aria-checked="true"'), "absent = on");
		assert.ok(toggle(render({ assessor: {} })).includes('aria-checked="true"'));
		assert.ok(toggle(render({ assessor: { enabled: false } })).includes('aria-checked="false"'), "stored off renders off");
		assert.deepEqual(composeAssessor(undefined, false), { assessor: { enabled: false } });
		assert.deepEqual(composeAssessor({ learnDocs: { enabled: false }, tools: { demo: false } }, true), {
			learnDocs: { enabled: false },
			tools: { demo: false },
			assessor: { enabled: true },
		});
	});
});
