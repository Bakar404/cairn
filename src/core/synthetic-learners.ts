/**
 * The synthetic learners (M23): scripted students who play practice
 * sessions against the real tutor, so the doctrine graders have sessions
 * to grade. After every tutor turn a learner reads the record and answers
 * the way one kind of student would:
 *
 *  - confused: never finds a way in, asks for a hint, then asks to end
 *    the problem;
 *  - overconfident: makes a slip, insists he is right, then corrects
 *    himself;
 *  - careless: makes a slip, then fixes it.
 *
 * The oracle is the tutor's own committed solution (the problem call's
 * modelSolution): a learner who "solves" submits it, and a slip is that
 * solution with one detail changed. The learner's side stays scripted and
 * short, and every verdict has a known right answer.
 */
import type { ChatInput } from "./input-events.ts";
import {
	PRACTICE_CONCLUDE_TOOL,
	activeProblemOf,
	cleanToolCallIds,
	type LhMessage,
} from "./native-messages.ts";

export type LearnerKind = "confused" | "overconfident" | "careless";

export const LEARNER_KINDS: readonly LearnerKind[] = ["confused", "overconfident", "careless"];

/** Problems each learner plays before he stops. */
export const PROBLEMS_PER_LEARNER = 2;
/** A hard stop on the learner's inputs, whatever the tutor does. */
export const MAX_LEARNER_INPUTS = 14;

export const LEARNER_OPENING = "Ready — give me a problem.";
/** His one nudge when the tutor answers without posing a problem. */
export const ASK_FOR_PROBLEM = "Can you give me a problem?";

export interface SyntheticLearner {
	kind: LearnerKind;
	/** The session's first message. */
	opening: string;
	/** His input after the tutor's turn, or null when he is done. */
	next(messages: readonly LhMessage[]): ChatInput | null;
}

const NO_SOLUTION = "I think I have it, but I can't put it into words.";

/** What he submits on a problem, by how many times he has already
 *  submitted on it; undefined once the script runs out. */
function scriptLine(kind: LearnerKind, submitted: number, solution: string): string | undefined {
	switch (kind) {
		case "confused":
			return [
				"Not sure where to start with this one.",
				"Still stuck — could I get a hint?",
				"Still nothing. I give up — please show me the solution.",
				"Please just end this problem — I want to move on.",
			][submitted];
		case "overconfident":
			return [
				`Easy. ${slipOf(solution)}`,
				"No, I'm sure my answer is right.",
				`Oh wait, I see it now: ${solution}`,
				"So is that right now?",
			][submitted];
		case "careless":
			return [slipOf(solution), `Oops, careless slip — fixed: ${solution}`, "Is that right now?"][submitted];
	}
}

function isLearnerInput(m: LhMessage): boolean {
	return m.role === "user" || (m.role === "custom" && (m.customType === "practice-thinking" || m.customType === "practice-next"));
}

function concludeAts(messages: readonly LhMessage[]): number[] {
	const clean = cleanToolCallIds(messages);
	const ats: number[] = [];
	for (let at = 0; at < messages.length; at++) {
		const m = messages[at]!;
		if (m.role !== "assistant") continue;
		if (m.content.some((b) => b.type === "toolCall" && b.name === PRACTICE_CONCLUDE_TOOL && clean.has(b.id))) ats.push(at);
	}
	return ats;
}

function userText(m: LhMessage): string {
	if (m.role !== "user") return "";
	return typeof m.content === "string" ? m.content : m.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
}

export function syntheticLearner(kind: LearnerKind): SyntheticLearner {
	return {
		kind,
		opening: LEARNER_OPENING,
		next(messages) {
			const inputs: number[] = [];
			for (let at = 0; at < messages.length; at++) if (isLearnerInput(messages[at]!)) inputs.push(at);
			if (inputs.length >= MAX_LEARNER_INPUTS) return null;

			const active = activeProblemOf(messages);
			if (active) {
				const committed = (active.input as { modelSolution?: unknown } | null)?.modelSolution;
				const solution = typeof committed === "string" && committed.trim() ? committed.trim() : NO_SOLUTION;
				let submitted = 0;
				for (const m of messages) {
					if (m.role !== "custom" || m.customType !== "practice-thinking") continue;
					if ((m.details as { problemCallId?: unknown } | null)?.problemCallId === active.toolCallId) submitted++;
				}
				const text = scriptLine(kind, submitted, solution);
				return text === undefined ? null : { type: "thinking", problemCallId: active.toolCallId, text };
			}

			const concluded = concludeAts(messages);
			if (concluded.length >= PROBLEMS_PER_LEARNER) return null;
			const lastConclusion = concluded[concluded.length - 1] ?? -1;
			const lastInput = inputs[inputs.length - 1] ?? -1;
			if (lastConclusion > lastInput) return { type: "next" };
			// The tutor answered without posing: ask once, then stop.
			const asked = inputs.some((at) => at > lastConclusion && userText(messages[at]!) === ASK_FOR_PROBLEM);
			return asked ? null : { type: "text", text: ASK_FOR_PROBLEM };
		},
	};
}

// ─── slips ──────────────────────────────────────────────────────────────────

const POLARITY_PAIRS: ReadonlyArray<readonly [string, string]> = [
	["increases", "decreases"],
	["always", "never"],
	["true", "false"],
	["greater", "less"],
	["larger", "smaller"],
	["maximum", "minimum"],
	["positive", "negative"],
	["odd", "even"],
	["higher", "lower"],
	["more", "fewer"],
];

const FLIPS = new Map<string, string>();
for (const [a, b] of POLARITY_PAIRS) {
	FLIPS.set(a, b);
	FLIPS.set(b, a);
}

const POLARITY_WORD = new RegExp(`\\b(?:${[...FLIPS.keys()].join("|")})\\b`, "gi");

function lastMatch(text: string, pattern: RegExp): RegExpExecArray | undefined {
	let last: RegExpExecArray | undefined;
	for (const match of text.matchAll(pattern)) last = match as RegExpExecArray;
	return last;
}

function splice(text: string, match: RegExpExecArray, replacement: string): string {
	return text.slice(0, match.index) + replacement + text.slice(match.index + match[0].length);
}

function sameCase(model: string, word: string): string {
	const first = model.charAt(0);
	return first && first !== first.toLowerCase() ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

/**
 * A plausible wrong version of a solution, for the learners who slip:
 * the last digit bumped, else the last polarity word flipped (increases
 * becomes decreases), else the last "is" negated (or un-negated), else the
 * final sentence dropped, else only the first half kept. Always differs
 * from its input.
 */
export function slipOf(solution: string): string {
	const text = solution.trim();
	if (!text) return "I think it's the opposite.";

	const digit = lastMatch(text, /\d/g);
	if (digit) return splice(text, digit, String((Number(digit[0]) + 1) % 10));

	const polar = lastMatch(text, POLARITY_WORD);
	if (polar) return splice(text, polar, sameCase(polar[0], FLIPS.get(polar[0].toLowerCase()) ?? polar[0]));

	const negated = lastMatch(text, /\bis not\b/gi);
	if (negated) return splice(text, negated, negated[0].slice(0, 2));
	const copula = lastMatch(text, /\bis\b/gi);
	if (copula) return splice(text, copula, `${copula[0]} not`);

	const sentences = text.split(/(?<=[.!?])\s+/);
	if (sentences.length > 1) return sentences.slice(0, -1).join(" ");

	const words = text.split(/\s+/);
	return `${words.slice(0, Math.max(1, Math.floor(words.length / 2))).join(" ")} …`;
}
