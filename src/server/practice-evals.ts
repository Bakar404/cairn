/**
 * The eval runner (M23): plays one synthetic learner through a practice
 * session against the tutor, through the same request path the app uses
 * (handleChatRequest, one turn per learner input), then grades the record
 * with the doctrine graders. The live command (scripts/evals.ts) runs it
 * against a real model in a throwaway data directory; the tests run it
 * against a scripted one.
 *
 * Outside the server barrel: the app never runs evals.
 */
import { chainsForSelection, formatChainLine } from "../core/chains.ts";
import type { PracticeAssessment } from "../core/contracts/chat.ts";
import { clip, gradeTranscript, type GraderResult } from "../core/doctrine-graders.ts";
import type { ChatInput } from "../core/input-events.ts";
import { newGraphContextMessage, type GraphContextPick, type LhMarkerMessage, type LhMessage } from "../core/native-messages.ts";
import { concludeCallIdsOf } from "../core/practice-assessment.ts";
import type { LearnerKind, SyntheticLearner } from "../core/synthetic-learners.ts";
import { handleChatRequest } from "./chat-handler.ts";
import { graphEvidenceFor } from "./graph.ts";
import { assessmentsInFlight, triggerAssessments, type AssessmentDeps } from "./practice-assessment.ts";
import { stores } from "./stores.ts";
import { runningTurn, turnFailure } from "./turn-runs.ts";

/** A hard stop on turns, above the learners' own cap. */
export const MAX_EVAL_TURNS = 16;
export const ASSESSMENT_TIMEOUT_MS = 90_000;

export interface EvalModel {
	provider: string;
	id: string;
}

export interface EvalSessionOptions {
	learner: SyntheticLearner;
	/** The tutor's model, stamped on the session like the strong slot is. */
	model: EvalModel;
	/** The propositions practiced, as the pick bar sends them. */
	picks?: readonly GraphContextPick[];
	title?: string;
	/** Tests inject a scripted agent; absent, the handler builds its own. */
	buildAgent?: Parameters<typeof handleChatRequest>[1];
	/** The answer check's model run; absent, the configured cheap slot. */
	assess?: AssessmentDeps["assess"];
	maxTurns?: number;
	assessmentTimeoutMs?: number;
}

export interface EvalSession {
	chatId: string;
	learner: LearnerKind;
	model: EvalModel;
	messages: LhMessage[];
	assessments: PracticeAssessment[];
	results: GraderResult[];
	/** Why the session did not finish cleanly: a refused request, a failed
	 *  turn, or answer checks that never landed. The graders still ran. */
	error?: string;
}

/** The session's map context, built the way POST /api/chats builds it. */
function practiceContext(picks: readonly GraphContextPick[]): LhMarkerMessage {
	const byId = new Map(stores.graphStore.readNodes().map((n) => [n.id, n]));
	const picked = picks.map((p) => byId.get(p.id)).filter((n) => n !== undefined);
	const chains = chainsForSelection(picked, stores.graphStore.readChains()).map((c) =>
		formatChainLine(c, Object.fromEntries(byId)),
	);
	return newGraphContextMessage(picks, chains, graphEvidenceFor(picks.map((p) => p.id)));
}

function messagesOf(chatId: string): LhMessage[] {
	return stores.chatStore.getChat(chatId)?.messages ?? [];
}

/** The first error event on a turn's wire, if any. */
function wireError(wire: string): string | undefined {
	for (const frame of wire.split("\n\n")) {
		if (!frame.startsWith("data: {")) continue;
		try {
			const event = JSON.parse(frame.slice("data: ".length)) as { type?: unknown; errorText?: unknown };
			if (event.type === "error") return typeof event.errorText === "string" ? event.errorText : "The turn failed.";
		} catch {
			/* not one whole frame */
		}
	}
	return undefined;
}

/** How the turn's last reply ended, when it did not end normally. */
function replyError(messages: readonly LhMessage[], from: number): string | undefined {
	for (let at = messages.length - 1; at >= from; at--) {
		const m = messages[at] as { role?: string; stopReason?: string; errorMessage?: string };
		if (m.role !== "assistant") continue;
		if (m.stopReason === "error") return m.errorMessage || "The model's reply failed.";
		if (m.stopReason === "aborted") return "The model's reply was aborted.";
		return undefined;
	}
	return undefined;
}

/** One learner input, played to the end of the tutor's turn. Resolves
 *  with an error message, or undefined when the turn settled cleanly. */
async function playTurn(
	chatId: string,
	input: ChatInput,
	buildAgent: EvalSessionOptions["buildAgent"],
): Promise<string | undefined> {
	const from = messagesOf(chatId).length;
	const ack = await handleChatRequest(
		new Request("http://eval/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chatId, input }),
		}),
		buildAgent,
	);
	const body = await ack.text();
	if (ack.status !== 200) return `The chat request was refused (${ack.status}): ${clip(body, 300)}`;
	// The POST only acknowledges; the turn's stream closes after the turn
	// is saved. A turn that already settled has left the registry.
	const handle = runningTurn(chatId);
	const wire = handle ? await new Response(handle.subscribe()).text() : "";
	return turnFailure(chatId) ?? replyError(messagesOf(chatId), from) ?? wireError(wire);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Play one learner through one practice session, then grade it. Never
 *  rejects for a failed turn: the error rides the result. */
export async function runEvalSession(options: EvalSessionOptions): Promise<EvalSession> {
	const { learner, model } = options;
	const chat = stores.chatStore.createChat(options.title ?? `Eval: ${learner.kind} learner`, "practice");
	stores.chatStore.saveSettings(chat.id, { model: { provider: model.provider, id: model.id } });
	if (options.picks && options.picks.length > 0) stores.chatStore.saveMessages(chat.id, [practiceContext(options.picks)]);

	const maxTurns = options.maxTurns ?? MAX_EVAL_TURNS;
	let input: ChatInput | null = { type: "text", text: learner.opening };
	let error: string | undefined;
	let turns = 0;
	while (input && !error) {
		if (turns >= maxTurns) {
			error = `Stopped after ${maxTurns} turns with the learner still playing.`;
			break;
		}
		turns++;
		error = await playTurn(chat.id, input, options.buildAgent);
		if (!error) input = learner.next(messagesOf(chat.id));
	}

	// The answer check runs in the background after each turn (outside
	// tests): wait those out, then check whatever no turn did.
	const deadline = Date.now() + (options.assessmentTimeoutMs ?? ASSESSMENT_TIMEOUT_MS);
	while (assessmentsInFlight(chat.id) && Date.now() < deadline) await sleep(200);
	if (assessmentsInFlight(chat.id)) {
		error ??= "The answer checks were still running when the eval stopped waiting; verdict honesty is ungraded.";
	} else {
		await triggerAssessments(chat.id, concludeCallIdsOf(messagesOf(chat.id)), options.assess ? { assess: options.assess } : {});
	}

	const record = stores.chatStore.getChat(chat.id);
	const messages = record?.messages ?? [];
	const assessments = record?.assessments ?? [];
	return {
		chatId: chat.id,
		learner: learner.kind,
		model: { provider: model.provider, id: model.id },
		messages,
		assessments,
		results: gradeTranscript(messages, { assessments }),
		...(error ? { error } : {}),
	};
}
