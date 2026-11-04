/**
 * The answer check (M24): after a practice problem concludes, a second
 * model with a fresh context grades the learner's own submissions against
 * the solution the tutor committed when it posed the problem. The record
 * keeps the grade (ChatRecord.assessments), and the conclude card flags
 * a disagreement with the tutor's outcome.
 *
 * Blind by design: the assessor never sees the tutor's outcome, verdict,
 * hints or conversation. It gets the problem, the committed solution and
 * what the learner submitted, so a tutor that talked itself into "solved"
 * cannot talk the assessor into it as well.
 *
 * Pure. The model run is src/agent/subagents/assessor.ts; the trigger and
 * the record write are src/server/practice-assessment.ts.
 */
import type { AssessorJudgment, PracticeAssessment } from "./contracts/chat.ts";
import {
	PRACTICE_CONCLUDE_TOOL,
	cleanToolCallIds,
	problemCallForConclude,
	type LhMessage,
} from "./native-messages.ts";

/** Outcomes that credit the learner's answer. */
const CREDITED: ReadonlySet<string> = new Set(["solved", "solvedWithHints"]);
/** Outcomes that make a claim a check can test. Surrendered and dismissed
 *  problems say nothing about an answer. */
const ASSESSABLE: ReadonlySet<string> = new Set([...CREDITED, "movedOn"]);

/** What one check sends at most: the newest submissions, each clipped. */
export const ASSESSOR_MAX_SUBMISSIONS = 10;
export const ASSESSOR_MAX_SUBMISSION_CHARS = 4000;

export interface AssessmentInput {
	concludeCallId: string;
	problemCallId: string;
	/** The tutor's outcome: kept for the agreement test, never sent. */
	outcome: string;
	statement: string;
	modelSolution: string;
	mode?: string;
	/** The learner's own submissions to this problem, oldest first. */
	answers: string[];
}

/** The conclude calls among `messages`, in order. */
export function concludeCallIdsOf(messages: readonly LhMessage[]): string[] {
	const ids: string[] = [];
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		for (const block of m.content) {
			if (block.type === "toolCall" && block.name === PRACTICE_CONCLUDE_TOOL) ids.push(block.id);
		}
	}
	return ids;
}

/** What one check needs, read from the record. Null when the conclude has
 *  nothing to test: an errored or unknown call, a surrendered or dismissed
 *  problem, a pose without a statement or committed solution, a submission
 *  the check cannot read (an image), or a moved-on problem the learner
 *  never answered.
 *
 *  Learner-only: the submissions are his practice-thinking messages for
 *  this problem plus anything he typed while it was open. The tutor's
 *  messages, hints included, are never collected. */
export function assessmentInputFor(messages: readonly LhMessage[], concludeCallId: string): AssessmentInput | null {
	let concludeIndex = -1;
	let outcome: unknown;
	for (let i = 0; i < messages.length && concludeIndex < 0; i++) {
		const m = messages[i]!;
		if (m.role !== "assistant") continue;
		for (const block of m.content) {
			if (block.type !== "toolCall" || block.id !== concludeCallId || block.name !== PRACTICE_CONCLUDE_TOOL) continue;
			concludeIndex = i;
			outcome = (block.arguments as { outcome?: unknown } | undefined)?.outcome;
		}
	}
	if (concludeIndex < 0 || typeof outcome !== "string" || !ASSESSABLE.has(outcome)) return null;
	if (!cleanToolCallIds(messages).has(concludeCallId)) return null;
	const problem = problemCallForConclude(messages, concludeCallId);
	const statement = problem?.input?.statement;
	const modelSolution = problem?.input?.modelSolution;
	if (!problem || typeof statement !== "string" || !statement.trim()) return null;
	if (typeof modelSolution !== "string" || !modelSolution.trim()) return null;
	const problemIndex = messages.findIndex(
		(m) => m.role === "assistant" && m.content.some((b) => b.type === "toolCall" && b.id === problem.toolCallId),
	);
	const answers: string[] = [];
	for (let i = problemIndex + 1; i < concludeIndex; i++) {
		const m = messages[i]!;
		if (m.role === "custom") {
			if (m.customType !== "practice-thinking") continue;
			const details = m.details as { problemCallId?: unknown; text?: unknown } | null;
			if (details?.problemCallId !== problem.toolCallId || typeof details.text !== "string") continue;
			if (details.text.trim()) answers.push(details.text.trim());
			continue;
		}
		if (m.role !== "user") continue;
		if (typeof m.content === "string") {
			if (m.content.trim()) answers.push(m.content.trim());
			continue;
		}
		if (m.content.some((b) => b.type !== "text")) return null;
		const text = m.content.map((b) => (b.type === "text" ? b.text : "")).join("\n").trim();
		if (text) answers.push(text);
	}
	if (answers.length === 0 && !CREDITED.has(outcome)) return null;
	const mode = problem.input?.mode;
	return {
		concludeCallId,
		problemCallId: problem.toolCallId,
		outcome,
		statement: statement.trim(),
		modelSolution: modelSolution.trim(),
		...(typeof mode === "string" && mode.trim() ? { mode: mode.trim() } : {}),
		answers,
	};
}

/** Does the judgment back the tutor's outcome? A credited outcome needs a
 *  correct answer; a moved-on problem needs one that is not correct. */
export function assessmentAgrees(outcome: string, judgment: AssessorJudgment): boolean {
	return CREDITED.has(outcome) ? judgment === "correct" : judgment !== "correct";
}

/** The entry for a credited problem the learner never answered, decided
 *  here without a model call. */
export function unansweredAssessment(input: AssessmentInput, at: string): PracticeAssessment {
	return {
		concludeCallId: input.concludeCallId,
		problemCallId: input.problemCallId,
		at,
		outcome: input.outcome,
		judgment: "unanswered",
		reason: "No answer was submitted for this problem.",
		agrees: false,
		steps: [],
	};
}

/** The assessor's task: the problem, the committed solution and the
 *  learner's submissions, oldest first with the last marked final. Never
 *  the tutor's outcome, verdict or hints. */
export function buildAssessorPrompt(input: AssessmentInput): string {
	const kept = input.answers.slice(-ASSESSOR_MAX_SUBMISSIONS);
	const omitted = input.answers.length - kept.length;
	const lines = [
		"## Problem",
		"",
		input.statement,
		"",
		...(input.mode ? ["## Mode", "", input.mode, ""] : []),
		"## Reference solution",
		"",
		input.modelSolution,
		"",
		"## The learner's submissions, oldest first",
		"",
		...(omitted > 0 ? [`(${omitted} earlier submission${omitted === 1 ? "" : "s"} omitted)`, ""] : []),
	];
	kept.forEach((answer, i) => {
		const final = i === kept.length - 1 ? " (final)" : "";
		lines.push(`### Submission ${omitted + i + 1}${final}`, "", clip(answer), "");
	});
	return lines.join("\n").trimEnd();
}

function clip(text: string): string {
	return text.length <= ASSESSOR_MAX_SUBMISSION_CHARS
		? text
		: `${text.slice(0, ASSESSOR_MAX_SUBMISSION_CHARS)}\n[truncated]`;
}

/** The log keyed by conclude call, for the transcript's cards. */
export function assessmentsByConclude(
	assessments: readonly PracticeAssessment[] | undefined,
): Record<string, PracticeAssessment> {
	const out: Record<string, PracticeAssessment> = {};
	for (const a of assessments ?? []) out[a.concludeCallId] = a;
	return out;
}

/** The judgment as words, for the card and the metadata row. */
export const JUDGMENT_LABEL: Readonly<Record<AssessorJudgment, string>> = {
	correct: "correct",
	partial: "partly correct",
	incorrect: "incorrect",
	unanswered: "no answer",
};
