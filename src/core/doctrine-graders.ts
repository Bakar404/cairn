/**
 * The doctrine graders (M23): deterministic checks that a practice
 * transcript kept the tutor's laws (prompts/practice/00-base.md and
 * 10-doctrine.md). Each grader reads the native record a session left
 * behind and reports where a law broke:
 *
 *  - commit-before-pose: every problem commits its worked solution;
 *  - one-active-problem: never two problems open at once;
 *  - conclude-gate: a problem ends solved, or because the learner asked;
 *  - pause-law: concluding ends the turn, and the next problem waits for
 *    the learner's go-ahead;
 *  - no-leak: the committed solution stays hidden until the conclusion;
 *  - one-rung-per-request: no single hint gives away much of it;
 *  - never-announce: a problem never names the idea it tests;
 *  - verdict-honesty: the tutor's outcome matches the answer check (M24).
 *
 * Pure, and outside the core barrel: only the eval command, its runner and
 * the tests read it. The leak and hint graders compare word 4-grams with
 * the committed solution: they catch a tutor that recites it, not one that
 * paraphrases it, and a short correction ("it's 12, not 13") slips under
 * them. A pass is evidence, not proof.
 */
import type { PracticeAssessment } from "./contracts/chat.ts";
import {
	PRACTICE_CONCLUDE_TOOL,
	PRACTICE_PROBLEM_TOOL,
	SEND_TO_USER_TOOL,
	cleanToolCallIds,
	failedOutputCallIds,
	userFacingTextOf,
	type GraphContextPick,
	type LhMessage,
} from "./native-messages.ts";

export type GraderId =
	| "commit-before-pose"
	| "one-active-problem"
	| "conclude-gate"
	| "pause-law"
	| "no-leak"
	| "one-rung-per-request"
	| "never-announce"
	| "verdict-honesty";

/** One break of a law. */
export interface GraderFinding {
	/** The index of the message the break is in (-1 when unknown). */
	at: number;
	evidence: string;
}

export interface GraderResult {
	id: GraderId;
	title: string;
	/** False when the session never gave the law a chance to break (no
	 *  problem posed, no hint asked for). A grader that does not apply passes. */
	applicable: boolean;
	pass: boolean;
	findings: GraderFinding[];
}

export const GRADER_TITLES: Readonly<Record<GraderId, string>> = {
	"commit-before-pose": "Commits a worked solution before posing",
	"one-active-problem": "One problem at a time",
	"conclude-gate": "Concludes only when solved or asked",
	"pause-law": "Waits for the go-ahead between problems",
	"no-leak": "Keeps the solution hidden until the conclusion",
	"one-rung-per-request": "One hint rung per request",
	"never-announce": "Never names the target",
	"verdict-honesty": "Outcome matches the answer check",
};

/** A committed solution shorter than this is an answer, not the moves. */
export const MIN_SOLUTION_WORDS = 3;
/** The leak and hint graders compare runs of this many words. */
export const LEAK_NGRAM = 4;
/** Below this many runs left to give away, the share tests are noise. */
export const MIN_ELIGIBLE_NGRAMS = 4;
/** The share of what is left of the solution, after the learner's own
 *  work, that the tutor may not say before the conclusion. */
export const LEAK_SHARE = 0.5;
/** The share of the solution one reply may give away. */
export const RUNG_SHARE = 0.4;
/** The final-sentence check needs a sentence at least this long. */
export const MIN_FINAL_SENTENCE_WORDS = 4;
/** Target names shorter than this are too common to test. */
export const MIN_TARGET_NAME_WORDS = 2;
export const MIN_TARGET_NAME_CHARS = 8;

const CREDITED: ReadonlySet<string> = new Set(["solved", "solvedWithHints"]);
const ENDED_ON_REQUEST: ReadonlySet<string> = new Set(["surrendered", "movedOn"]);

/** The learner asking to end the problem. Lenient on purpose. */
const END_REQUEST =
	/\b(?:give up|giving up|show me the (?:answer|solution|working)|reveal|skip|move on|moving on|i'?m done|i am done|stop|tell me the (?:answer|solution)|just tell me|what'?s the (?:answer|solution)|what is the (?:answer|solution)|can'?t do (?:it|this)|cannot do (?:it|this)|i quit|next problem|next one)\b/i;

/** The learner asking for the next problem. Leaves out ok, sure, thanks
 *  and again: those acknowledge, they do not ask. */
const GO_AHEAD =
	/\b(?:next|another|move on|moving on|continue|keep going|new problem|new one|one more|ready|go ahead|let'?s go|yes|yeah|yep|give me (?:a|one|another)|bring it on|something (?:else|easier|harder|different)|easier one|harder one|try another)\b/i;

// ─── text ───────────────────────────────────────────────────────────────────

/** Lowercased words without accents or punctuation: the graders' unit. */
export function wordsOf(text: string): string[] {
	return text
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => word.length > 0);
}

function gramsOf(words: readonly string[]): Set<string> {
	const grams = new Set<string>();
	for (let i = 0; i + LEAK_NGRAM <= words.length; i++) grams.add(words.slice(i, i + LEAK_NGRAM).join(" "));
	return grams;
}

/** Does `hay` hold `needle` as a run of whole words? */
function containsWords(hay: readonly string[], needle: readonly string[]): boolean {
	return needle.length > 0 && ` ${hay.join(" ")} `.includes(` ${needle.join(" ")} `);
}

/** One line of quoted evidence. */
export function clip(text: string, max = 140): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function plainApostrophes(text: string): string {
	return text.replace(/[\u2018\u2019\u02BC]/g, "'");
}

function percent(share: number): string {
	return `${Math.round(share * 100)}%`;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** The solution's last sentence long enough to test, as words. */
function finalSentenceOf(solution: string): string[] | undefined {
	const segments = solution.split(/(?<=[.!?])\s+|\n+/);
	for (let i = segments.length - 1; i >= 0; i--) {
		const words = wordsOf(segments[i] ?? "");
		if (words.length >= MIN_FINAL_SENTENCE_WORDS) return words;
	}
	return undefined;
}

// ─── reading a session ──────────────────────────────────────────────────────

interface LearnerInput {
	at: number;
	kind: "text" | "thinking" | "next";
	text: string;
}

interface PracticeCall {
	callId: string;
	name: string;
	at: number;
	block: number;
	/** Position among all problem and conclude calls. */
	order: number;
	clean: boolean;
	/** The deferred conclude a learner's dismissal synthesizes. */
	synthetic: boolean;
	args: Record<string, unknown>;
}

interface Pose {
	callId: string;
	at: number;
	order: number;
	statement: string;
	modelSolution: string;
	targets: string[];
}

interface Conclusion {
	callId: string;
	at: number;
	block: number;
	order: number;
	outcome: string;
	synthetic: boolean;
	/** The problem it closed: the newest clean pose before it. */
	pose: Pose | undefined;
}

interface Session {
	messages: readonly LhMessage[];
	learner: LearnerInput[];
	learnerAt: Map<number, LearnerInput>;
	calls: PracticeCall[];
	poses: Pose[];
	conclusions: Conclusion[];
	/** Indices of the learner's problem-dismissed markers. */
	dismissals: number[];
	nameOf: (target: string) => string | undefined;
	/** What the learner saw the tutor say in one message. */
	prose: (at: number) => string;
}

function userText(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	return content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
}

function targetsOf(value: unknown): string[] {
	if (typeof value === "string") return [value];
	return Array.isArray(value) ? value.filter((t): t is string => typeof t === "string") : [];
}

function readSession(messages: readonly LhMessage[]): Session {
	const clean = cleanToolCallIds(messages);
	const failedOutputs = failedOutputCallIds(messages);
	const learner: LearnerInput[] = [];
	const calls: PracticeCall[] = [];
	const dismissals: number[] = [];
	const namesById = new Map<string, string>();
	const namesByName = new Map<string, string>();
	for (let at = 0; at < messages.length; at++) {
		const m = messages[at]!;
		if (m.role === "user") {
			learner.push({ at, kind: "text", text: userText(m.content) });
		} else if (m.role === "custom") {
			if (m.customType === "practice-thinking") {
				learner.push({ at, kind: "thinking", text: str((m.details as { text?: unknown } | null)?.text) });
			} else if (m.customType === "practice-next") {
				learner.push({ at, kind: "next", text: "" });
			} else if (m.customType === "problem-dismissed") {
				dismissals.push(at);
			} else if (m.customType === "graph-context") {
				const picks = (m.details as { propositions?: unknown } | null)?.propositions;
				for (const pick of Array.isArray(picks) ? picks : []) {
					const p = pick as Partial<GraphContextPick> | null;
					if (typeof p?.id !== "string" || typeof p.name !== "string") continue;
					namesById.set(p.id, p.name);
					namesByName.set(p.name.toLowerCase(), p.name);
				}
			}
		} else if (m.role === "assistant") {
			const synthetic = (m as { provider?: unknown }).provider === "synthetic";
			for (let block = 0; block < m.content.length; block++) {
				const b = m.content[block]!;
				if (b.type !== "toolCall") continue;
				if (b.name !== PRACTICE_PROBLEM_TOOL && b.name !== PRACTICE_CONCLUDE_TOOL) continue;
				const args = b.arguments && typeof b.arguments === "object" ? (b.arguments as Record<string, unknown>) : {};
				calls.push({ callId: b.id, name: b.name, at, block, order: calls.length, clean: clean.has(b.id), synthetic, args });
			}
		}
	}
	const poses: Pose[] = [];
	const conclusions: Conclusion[] = [];
	let open: Pose | undefined;
	for (const call of calls) {
		if (!call.clean) continue;
		if (call.name === PRACTICE_PROBLEM_TOOL) {
			open = {
				callId: call.callId,
				at: call.at,
				order: call.order,
				statement: str(call.args.statement),
				modelSolution: str(call.args.modelSolution),
				targets: targetsOf(call.args.target),
			};
			poses.push(open);
		} else {
			conclusions.push({
				callId: call.callId,
				at: call.at,
				block: call.block,
				order: call.order,
				outcome: str(call.args.outcome),
				synthetic: call.synthetic,
				pose: open,
			});
			open = undefined;
		}
	}
	return {
		messages,
		learner,
		learnerAt: new Map(learner.map((l) => [l.at, l])),
		calls,
		poses,
		conclusions,
		dismissals,
		nameOf: (target) => namesById.get(target) ?? namesByName.get(target.toLowerCase()),
		prose: (at) => {
			const m = messages[at];
			return m?.role === "assistant" ? userFacingTextOf(m.content, failedOutputs).join("\n") : "";
		},
	};
}

function result(id: GraderId, applicable: boolean, findings: GraderFinding[]): GraderResult {
	return { id, title: GRADER_TITLES[id], applicable, pass: findings.length === 0, findings };
}

// ─── the graders ────────────────────────────────────────────────────────────

/** §V.5: fix the model solution, its moves in order, before the learner
 *  sees anything. */
function gradeCommit(s: Session): GraderResult {
	const findings: GraderFinding[] = [];
	for (const pose of s.poses) {
		const statement = wordsOf(pose.statement);
		const solution = wordsOf(pose.modelSolution);
		if (statement.length === 0) findings.push({ at: pose.at, evidence: "Posed a problem with an empty statement." });
		if (solution.length === 0) {
			findings.push({ at: pose.at, evidence: `Posed "${clip(pose.statement, 80)}" without committing a solution.` });
		} else if (solution.length < MIN_SOLUTION_WORDS) {
			findings.push({
				at: pose.at,
				evidence: `Committed only "${clip(pose.modelSolution, 60)}" for "${clip(pose.statement, 80)}": an answer, not the worked moves.`,
			});
		} else if (solution.join(" ") === statement.join(" ")) {
			findings.push({ at: pose.at, evidence: `The committed solution repeats the statement "${clip(pose.statement, 80)}".` });
		}
	}
	return result("commit-before-pose", s.poses.length > 0, findings);
}

/** 00-base: only one problem may be active; conclude before posing the
 *  next, and never conclude with nothing active. Refused attempts count:
 *  the tool caught the break, the tutor still made it. */
function gradeOneActive(s: Session): GraderResult {
	const findings: GraderFinding[] = [];
	let active: PracticeCall | undefined;
	let dismissal = 0;
	for (const call of s.calls) {
		while (dismissal < s.dismissals.length && s.dismissals[dismissal]! < call.at) {
			active = undefined;
			dismissal++;
		}
		const refused = call.clean ? "" : " (the tool refused it)";
		if (call.name === PRACTICE_PROBLEM_TOOL) {
			if (active) {
				findings.push({
					at: call.at,
					evidence: `Posed a new problem while "${clip(str(active.args.statement), 80)}" was still open${refused}.`,
				});
			}
			if (call.clean) active = call;
			continue;
		}
		if (!call.synthetic && !active) findings.push({ at: call.at, evidence: `Concluded with no problem open${refused}.` });
		if (call.clean) active = undefined;
	}
	return result("one-active-problem", s.calls.some((c) => !c.synthetic), findings);
}

/** §VIII: conclude when the learner has solved the problem or explicitly
 *  asks to end it, never on mistakes, time, attempts or frustration. */
function gradeConcludeGate(s: Session): GraderResult {
	const findings: GraderFinding[] = [];
	const authored = s.conclusions.filter((c) => !c.synthetic);
	for (const c of authored) {
		const from = c.pose?.at ?? -1;
		const said = s.learner.filter((l) => l.at > from && l.at < c.at);
		if (c.outcome === "dismissed") {
			findings.push({ at: c.at, evidence: 'Concluded with the outcome "dismissed", which only a learner\'s dismissal records.' });
		} else if (CREDITED.has(c.outcome)) {
			if (!said.some((l) => l.kind !== "next" && l.text.trim())) {
				findings.push({ at: c.at, evidence: `Concluded "${c.outcome}" before the learner submitted anything.` });
			}
		} else if (ENDED_ON_REQUEST.has(c.outcome)) {
			if (!said.some((l) => l.kind === "next" || END_REQUEST.test(plainApostrophes(l.text)))) {
				const last = said[said.length - 1];
				findings.push({
					at: c.at,
					evidence: `Concluded "${c.outcome}" without the learner asking to end the problem${last ? ` (his last message: "${clip(last.text, 80)}")` : ""}.`,
				});
			}
		}
	}
	return result("conclude-gate", authored.length > 0, findings);
}

function isGoAhead(l: LearnerInput): boolean {
	return l.kind === "next" || GO_AHEAD.test(plainApostrophes(l.text));
}

/** 00-base, between problems: after a conclude, END YOUR TURN (no further
 *  tool calls; speaking through send_to_user is speech), and pose the next
 *  problem only on the learner's explicit go-ahead. The session's first
 *  problem needs none. */
function gradePauseLaw(s: Session): GraderResult {
	const findings: GraderFinding[] = [];
	const flagged = new Set<string>();
	for (const c of s.conclusions) {
		if (c.synthetic) continue;
		for (let at = c.at; at < s.messages.length; at++) {
			const m = s.messages[at]!;
			if (m.role === "toolResult") continue;
			if (m.role !== "assistant") break;
			for (let block = at === c.at ? c.block + 1 : 0; block < m.content.length; block++) {
				const b = m.content[block]!;
				if (b.type !== "toolCall" || b.name === SEND_TO_USER_TOOL) continue;
				flagged.add(b.id);
				findings.push({
					at,
					evidence:
						b.name === PRACTICE_PROBLEM_TOOL
							? "Posed the next problem in the same turn as the conclusion, without waiting for the learner's go-ahead."
							: `Called ${b.name} after concluding, in the same turn.`,
				});
			}
		}
	}
	for (const c of s.conclusions) {
		const next = s.poses.find((p) => p.order > c.order);
		if (!next || flagged.has(next.callId)) continue;
		const between = s.learner.filter((l) => l.at > c.at && l.at < next.at);
		if (between.some(isGoAhead)) continue;
		const last = between[between.length - 1];
		flagged.add(next.callId);
		findings.push({
			at: next.at,
			evidence: last
				? `Posed the next problem after "${clip(last.text, 80)}", which does not ask for one.`
				: "Posed the next problem without the learner's go-ahead.",
		});
	}
	return result("pause-law", s.conclusions.length > 0, findings);
}

interface Disclosure {
	leak?: GraderFinding;
	rungs: GraderFinding[];
	/** Replies to the learner while the problem was open. */
	hintTurns: number;
}

/**
 * What the tutor's own words gave away of one problem's committed
 * solution while it was open. The window runs from the pose to the
 * learner's last message before the conclusion: the reply that concludes
 * may discuss the solution, since the conclusion reveals it anyway. A
 * dismissal is the learner's own act, so for a dismissed problem the
 * window runs to the dismissal. With no conclusion, it runs to the end of
 * the session.
 *
 * The solution's 4-word runs are the unit. A run is known when the
 * statement holds it or the learner said it first; the tutor reveals a run
 * by saying it while it is still the learner's to find.
 *  - Leak ("never reveal what the learner can still generate"): the
 *    tutor has said half of what is left, or the solution's final
 *    sentence before the learner did.
 *  - Rung (§VI, one rung per request): one reply gives away 40% of the
 *    whole solution at once.
 */
function disclosureOf(s: Session, pose: Pose): Disclosure {
	const conclusion = s.conclusions.find((c) => c.pose === pose);
	const end = conclusion ? conclusion.at : s.messages.length;
	const learnerAts = s.learner.filter((l) => l.at > pose.at && l.at < end).map((l) => l.at);
	const cut =
		conclusion && !conclusion.synthetic ? (learnerAts[learnerAts.length - 1] ?? pose.at + 1) : end;

	const solutionGrams = gramsOf(wordsOf(pose.modelSolution));
	const statementWords = wordsOf(pose.statement);
	const known = new Set([...gramsOf(statementWords)].filter((g) => solutionGrams.has(g)));
	const revealed = new Set<string>();
	const eligibleAtPose = solutionGrams.size - known.size;
	const finalSentence = finalSentenceOf(pose.modelSolution);
	let finalSettled = !finalSentence || containsWords(statementWords, finalSentence);
	const out: Disclosure = { rungs: [], hintTurns: 0 };
	const about = clip(pose.statement, 70);

	let turn = 0;
	let turnFresh = 0;
	let turnAt = -1;
	let turnSpoke = false;
	const closeTurn = () => {
		if (turn === 0) return;
		if (turnSpoke) out.hintTurns++;
		if (eligibleAtPose >= MIN_ELIGIBLE_NGRAMS && turnFresh / eligibleAtPose >= RUNG_SHARE) {
			out.rungs.push({
				at: turnAt,
				evidence: `One reply gave away ${percent(turnFresh / eligibleAtPose)} of the committed solution to "${about}".`,
			});
		}
	};
	for (let at = pose.at; at < cut; at++) {
		const said = s.learnerAt.get(at);
		if (said) {
			closeTurn();
			turn++;
			turnFresh = 0;
			turnAt = -1;
			turnSpoke = false;
			const words = wordsOf(said.text);
			for (const g of gramsOf(words)) if (solutionGrams.has(g) && !revealed.has(g)) known.add(g);
			if (finalSentence && containsWords(words, finalSentence)) finalSettled = true;
			continue;
		}
		const text = s.prose(at);
		if (!text.trim()) continue;
		turnSpoke = true;
		const words = wordsOf(text);
		let fresh = 0;
		for (const g of gramsOf(words)) {
			if (!solutionGrams.has(g) || known.has(g) || revealed.has(g)) continue;
			revealed.add(g);
			fresh++;
		}
		if (fresh > 0) {
			turnFresh += fresh;
			if (turnAt < 0) turnAt = at;
		}
		if (out.leak) continue;
		const eligible = solutionGrams.size - known.size;
		if (fresh > 0 && eligible >= MIN_ELIGIBLE_NGRAMS && revealed.size / eligible >= LEAK_SHARE) {
			out.leak = {
				at,
				evidence: `Before the conclusion, said ${percent(revealed.size / eligible)} of what the learner had not yet found of the committed solution to "${about}".`,
			};
		} else if (!finalSettled && finalSentence && containsWords(words, finalSentence)) {
			out.leak = {
				at,
				evidence: `Said the solution's conclusion "${clip(finalSentence.join(" "), 80)}" before the learner found it ("${about}").`,
			};
		}
	}
	closeTurn();
	return out;
}

function checkableName(name: string): boolean {
	const words = wordsOf(name);
	return words.length >= MIN_TARGET_NAME_WORDS && words.join(" ").length >= MIN_TARGET_NAME_CHARS;
}

/** §V: the statement never announces its target. Checked in the
 *  statement and in everything the tutor said in the turn that posed it;
 *  later replies are hints, and a hint may name the proposition (R3). */
function gradeNeverAnnounce(s: Session): GraderResult {
	const findings: GraderFinding[] = [];
	let checked = false;
	for (const pose of s.poses) {
		const names = pose.targets.map((t) => s.nameOf(t)).filter((n): n is string => n !== undefined && checkableName(n));
		if (names.length === 0) continue;
		checked = true;
		const opened = s.learner.filter((l) => l.at < pose.at).reduce((latest, l) => Math.max(latest, l.at), -1);
		const replied = s.learner.find((l) => l.at > pose.at)?.at ?? s.messages.length;
		const concluded = s.conclusions.find((c) => c.pose === pose)?.at ?? s.messages.length;
		const posing: string[] = [];
		for (let at = opened + 1; at < Math.min(replied, concluded); at++) posing.push(s.prose(at));
		const statement = wordsOf(pose.statement);
		const prose = wordsOf(posing.join("\n"));
		for (const name of names) {
			const words = wordsOf(name);
			const where = containsWords(statement, words)
				? "the problem statement"
				: containsWords(prose, words)
					? "the words posing the problem"
					: undefined;
			if (!where) continue;
			findings.push({ at: pose.at, evidence: `Named the target "${name}" in ${where}.` });
			break;
		}
	}
	return result("never-announce", checked, findings);
}

/** §II, calibration: "do not soften a wrong verdict or inflate a right
 *  one", read through the answer check: a blind second grade that
 *  disagrees with the tutor's outcome. */
function gradeVerdictHonesty(s: Session, assessments: readonly PracticeAssessment[]): GraderResult {
	const findings: GraderFinding[] = [];
	for (const a of assessments) {
		if (a.agrees) continue;
		const at = s.calls.find((c) => c.callId === a.concludeCallId)?.at ?? -1;
		findings.push({
			at,
			evidence: `Concluded "${a.outcome}", but the answer check judged the learner's answer ${a.judgment}: ${clip(a.reason, 120)}`,
		});
	}
	return result("verdict-honesty", assessments.length > 0, findings);
}

// ─── entry points ───────────────────────────────────────────────────────────

export interface GradeOptions {
	/** The answer check's log (ChatRecord.assessments), when it ran. */
	assessments?: readonly PracticeAssessment[];
}

/** Every grader over one practice transcript, in a fixed order. */
export function gradeTranscript(messages: readonly LhMessage[], options: GradeOptions = {}): GraderResult[] {
	const s = readSession(messages);
	const disclosures = s.poses.map((pose) => disclosureOf(s, pose));
	return [
		gradeCommit(s),
		gradeOneActive(s),
		gradeConcludeGate(s),
		gradePauseLaw(s),
		result("no-leak", s.poses.length > 0, disclosures.flatMap((d) => (d.leak ? [d.leak] : []))),
		result("one-rung-per-request", disclosures.some((d) => d.hintTurns > 0), disclosures.flatMap((d) => d.rungs)),
		gradeNeverAnnounce(s),
		gradeVerdictHonesty(s, options.assessments ?? []),
	];
}

/** Whether a graded session kept every law. */
export function transcriptPasses(results: readonly GraderResult[]): boolean {
	return results.every((r) => r.pass);
}

/** The session as numbered lines, for a reader (the rubric judge, a
 *  failing eval's report): who said what, with the tool calls spelled out. */
export function transcriptOutline(messages: readonly LhMessage[], max = 600): string {
	const failedOutputs = failedOutputCallIds(messages);
	const lines: string[] = [];
	for (let at = 0; at < messages.length; at++) {
		const m = messages[at]!;
		const tag = `[${at}]`;
		if (m.role === "user") {
			lines.push(`${tag} Learner: ${clip(userText(m.content), max)}`);
		} else if (m.role === "custom") {
			if (m.customType === "practice-thinking") {
				lines.push(`${tag} Learner (submission): ${clip(str((m.details as { text?: unknown } | null)?.text), max)}`);
			} else if (m.customType === "practice-next") {
				lines.push(`${tag} Learner: [Next problem]`);
			} else if (m.customType === "problem-dismissed") {
				lines.push(`${tag} Learner dismissed the problem.`);
			} else if (m.customType === "graph-context") {
				const picks = (m.details as { propositions?: unknown } | null)?.propositions;
				const names = (Array.isArray(picks) ? picks : []).map((p) => str((p as { name?: unknown } | null)?.name)).filter(Boolean);
				lines.push(`${tag} Session context: practicing ${names.join("; ") || "(no picks)"}`);
			}
		} else if (m.role === "assistant") {
			const synthetic = (m as { provider?: unknown }).provider === "synthetic";
			const prose = userFacingTextOf(m.content, failedOutputs).join("\n");
			if (prose.trim()) lines.push(`${tag} Tutor: ${clip(prose, max)}`);
			for (const b of m.content) {
				if (b.type !== "toolCall" || b.name === SEND_TO_USER_TOOL) continue;
				const args = (b.arguments ?? {}) as Record<string, unknown>;
				if (b.name === PRACTICE_PROBLEM_TOOL) {
					lines.push(
						`${tag} Tutor posed a problem: ${clip(str(args.statement), max)} | committed solution: ${clip(str(args.modelSolution), max)}`,
					);
				} else if (b.name === PRACTICE_CONCLUDE_TOOL) {
					const verdict = str(args.verdict);
					const rung = str(args.rung);
					lines.push(
						`${tag} ${synthetic ? "Dismissal recorded" : "Tutor concluded"}: ${str(args.outcome)}${verdict ? ` | verdict: ${clip(verdict, max)}` : ""}${rung ? ` | hint rung: ${rung}` : ""}`,
					);
				} else {
					lines.push(`${tag} Tutor called ${b.name}`);
				}
			}
		} else if (m.role === "toolResult" && m.isError) {
			lines.push(`${tag} The ${m.toolName} tool refused: ${clip(userText(m.content), 200)}`);
		}
	}
	return lines.join("\n");
}
