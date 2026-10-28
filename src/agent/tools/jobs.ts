import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import type { JobRecord } from "../../core/contracts.ts";
import type { JobStore } from "../../core/ports.ts";

/**
 * Async sub-agent job tools (vision §2.5; W2/W6 kinds + the pi-model
 * protocol). SERVER-EXECUTED: each call creates the job record, fires the
 * background runner (via the injected spawn seam — the agent layer never
 * imports one), and resolves IMMEDIATELY with a fire-and-forget ack. The
 * teacher's turn does NOT end at the call; the result arrives later as a
 * steer message that wakes the teacher in a new turn. See contracts.ts
 * "THE ASYNC PROTOCOL".
 */

/** What the job tools need at execute time (injected by the composition root). */
export interface JobToolContext {
	chatId: string;
	/** Creates the job record (deduped by toolCallId). */
	jobStore: JobStore;
	/** Fire the background runner for a fresh job — fire-and-forget. The
	 *  input rides along because the spawn happens MID-STREAM, before
	 *  onFinish persists the tool part — a transcript scan would race it. */
	spawn: (job: JobRecord, input: JobInput) => void;
	/** Search-provider availability, retained for existing composition seams.
	 *  Research dispatch does not depend on it: web_fetch is keyless and
	 *  web_search reports a missing provider as a recoverable tool result. */
	searchAvailable?: () => boolean;
	/** True while the Manim renderer is ready (M13). The animation tool is
	 *  offered only then, so the teacher never dispatches one that can't
	 *  run. Absent = no animation tool. */
	animationAvailable?: () => boolean;
	/** True while Work IQ is switched on (M10). The work_context tool is
	 *  offered only then — and only the prober's registry picks it up.
	 *  Absent = no work_context tool. */
	workContextAvailable?: () => boolean;
}

export const researchInputSchema = Type.Object({
	question: Type.String({
		description: "The single research question to answer. Make it specific — the researcher sees nothing else of the lesson.",
	}),
	context: Type.Optional(
		Type.String({
			description: "Why you need this / what the lesson needs it for — focuses the brief. One or two sentences.",
		}),
	),
});

export const demoInputSchema = Type.Object({
	title: Type.String({ description: "Short title for the demo card, e.g. 'Damped harmonic oscillator'." }),
	brief: Type.String({
		description:
			"Precise brief for the builder: the concept, the parameters/controls and what each does, the interactions, and the visual style. " +
			"The builder sees NOTHING else of the lesson — include everything it needs, including necessary formulas and constants.",
	}),
});

export const visualInputSchema = Type.Object({
	brief: Type.String({
		description:
			"Precise brief for ONE static figure: exactly what it must show — coordinates, labels, proportions, orientation. " +
			"The maker sees NOTHING else of the lesson; a wrong or vague brief produces a wrong figure.",
	}),
});

export const pdfInputSchema = Type.Object({
	path: Type.String({ description: "Path to the learner's PDF (relative or absolute), exactly as they gave it." }),
	question: Type.String({
		description:
			"What you need from the document — the specific content, explanation, or answer to extract and brief. " +
			"The reader sees NOTHING else of the lesson.",
	}),
});

export const animationInputSchema = Type.Object({
	title: Type.String({ description: "Short title for the animation card, e.g. 'How a hash table resizes'." }),
	brief: Type.String({
		description:
			"The beats in order: what appears, moves, or transforms at each step, with exact values, labels, and directions — " +
			"and what the learner should notice at each beat. The maker sees NOTHING else of the lesson, and the animation is " +
			"silent: say which words must be on screen.",
	}),
});

export const workContextInputSchema = Type.Object({
	topic: Type.String({
		description:
			"The subject the learner wants to learn, in a few plain words (e.g. 'Kubernetes networking'). " +
			"No names of people, customers or projects.",
	}),
});

/**
 * The per-call dispatch: create the job (idempotent by toolCallId), fire the
 * runner, and return the ack. Shared by every job tool — only kind differs.
 */
function dispatch(
	ctx: JobToolContext,
	kind: JobRecord["kind"],
	toolCallId: string,
	ack: string,
	input: JobInput,
): string {
	const existing = ctx.jobStore.findJobByToolCallId(ctx.chatId, toolCallId);
	const job = existing ?? ctx.jobStore.createJob({ kind, chatId: ctx.chatId, toolCallId, input });
	if (!existing) ctx.spawn(job, input);
	return `Dispatched (job ${job.id}). ${ack}`;
}

const RESEARCH_ACK =
	"This call is fire-and-forget: continue your turn and keep teaching — do not wait, poll, or mention waiting. " +
	"The researched brief arrives as a new message when ready and the lesson resumes from it; cite its sources when you use them.";
const DEMO_ACK =
	"This call is fire-and-forget: continue your turn and keep teaching — do not wait, poll, or mention waiting. " +
	"The tested demo arrives as a new message when ready and is rendered in the lesson; teach with it then.";
const VISUAL_ACK =
	"This call is fire-and-forget: continue your turn and keep teaching — do not wait, poll, or mention waiting. " +
	"The verified figure arrives as a new message when ready and is rendered in the lesson; reference it then.";
const PDF_ACK =
	"This call is fire-and-forget: continue your turn and keep teaching — do not wait, poll, or mention waiting. " +
	"The document brief arrives as a new message when ready; weave it into the lesson and cite its pages.";
const ANIMATION_ACK =
	"This call is fire-and-forget: continue your turn and keep teaching — do not wait, poll, or mention waiting. " +
	"The finished animation arrives as a new message when ready and plays in the lesson; narrate it then.";
const WORK_CONTEXT_ACK =
	"This call is fire-and-forget: continue your turn — do not wait or poll. Tell the learner in one short sentence " +
	"that you're checking what their work already covers, then ask your first probe question now. The topics arrive " +
	"later as a new message: a starting guess for where to probe first, never evidence of what the learner knows.";
const WORK_CONTEXT_ALREADY_ASKED =
	"Work IQ was already asked in this session — don't call it again; probe as usual.";

const RESEARCH_DESCRIPTION =
	"Dispatch a background web-research agent: fact verification, current data, or niche specifics you are not certain about. " +
	"The call is ASYNC and fire-and-forget — it resolves immediately and your turn continues; the research brief arrives later " +
	"as a new message and the lesson resumes from it. Cite the brief's sources when you use them. " +
	"NEVER use it for things you know cold, internal reasoning, or math.";
const DEMO_DESCRIPTION =
	"Dispatch a background sub-agent that BUILDS and headlessly TESTS an interactive teaching instrument — a single-file HTML " +
	"demo (parameter sweep, simulation, animation, sampling) rendered live in the lesson. Use it when the concept is DYNAMIC: " +
	"something to sweep, animate, or sample is better experienced than described. " +
	"The call is ASYNC and fire-and-forget — it resolves immediately and your turn continues; the tested demo arrives later " +
	"as a new message. Write a precise brief: concept, controls, interactions, style.";
const VISUAL_DESCRIPTION =
	"Dispatch a background sub-agent that hand-authors ONE precise SVG figure, renders it, LOOKS at the render, and iterates " +
	"until correct. Use it for exact spatial pictures auto-layout diagrams can't do: coordinate geometry, number lines, vectors, " +
	"function plots, physical layouts. For flows/relations/taxonomies write mermaid inline instead. " +
	"The call is ASYNC and fire-and-forget — it resolves immediately and your turn continues; the verified figure arrives later " +
	"as a new message.";
const PDF_DESCRIPTION =
	"Dispatch a background sub-agent that READS a learner-provided PDF on your behalf (triage, targeted extraction, visual page " +
	"reading for equations and diagrams) and returns a brief with page citations. Use it when the learner gives you a PDF path " +
	"and you need its CONTENT for the lesson. The call is ASYNC and fire-and-forget — it resolves immediately and your turn " +
	"continues; the brief arrives later as a new message. For quick looks at plain text or image files, use the read tool " +
	"directly instead of dispatching.";
const ANIMATION_DESCRIPTION =
	"Dispatch a background sub-agent that writes ONE short, silent Manim animation (5–40 seconds) of an idea that UNFOLDS " +
	"OVER TIME — a process, a transformation, a quantity changing, steps in order — previews it, LOOKS at the frames, and " +
	"iterates until correct; the video then plays in the lesson. Use it when watching the change teaches more than a still " +
	"picture. For one static figure use visual; for something the learner should control use demo. " +
	"The call is ASYNC and fire-and-forget — it resolves immediately and your turn continues; the finished animation arrives " +
	"later as a new message.";
const WORK_CONTEXT_DESCRIPTION =
	"Ask Work IQ (Microsoft 365 Copilot) which parts of the subject the learner's own work — email, meetings, chats, " +
	"documents — already touches. Call it ONCE, at the very start of the probe, before your first question. " +
	"The call is ASYNC and fire-and-forget — it resolves immediately and your turn continues; the topics arrive later as a " +
	"new message. They only suggest where to probe first: check each with your own questions, and never count them as " +
	"evidence in probe_done.";

/**
 * Per-request job tool registry: each tool closes over the composition root's
 * context (chatId + jobStore + the spawn seam), so concurrent chats never
 * share state. chat-handler wires it each turn; tests wire their own.
 *
 * Research remains available without a search-provider key; the role's
 * existing user-toggle filtering still applies outside this registry. The
 * animation tool joins only while ctx.animationAvailable() says the Manim
 * renderer is ready; work_context only while ctx.workContextAvailable()
 * says Work IQ is switched on, and it dispatches at most once per chat.
 */
export function jobTools(ctx: JobToolContext): Record<string, AgentTool<any>> {
	const tools: Record<string, AgentTool<any>> = {
		research: {
			name: "research",
			label: "research",
			description: RESEARCH_DESCRIPTION,
			parameters: researchInputSchema,
			execute: serverExecute("research", researchInputSchema, (input, { toolCallId }) =>
				dispatch(ctx, "research", toolCallId, RESEARCH_ACK, input),
			),
		},
		demo: {
			name: "demo",
			label: "demo",
			description: DEMO_DESCRIPTION,
			parameters: demoInputSchema,
			execute: serverExecute("demo", demoInputSchema, (input, { toolCallId }) => dispatch(ctx, "demo", toolCallId, DEMO_ACK, input)),
		},
		visual: {
			name: "visual",
			label: "visual",
			description: VISUAL_DESCRIPTION,
			parameters: visualInputSchema,
			execute: serverExecute("visual", visualInputSchema, (input, { toolCallId }) =>
				dispatch(ctx, "visual", toolCallId, VISUAL_ACK, input),
			),
		},
		pdf: {
			name: "pdf",
			label: "pdf",
			description: PDF_DESCRIPTION,
			parameters: pdfInputSchema,
			execute: serverExecute("pdf", pdfInputSchema, (input, { toolCallId }) => dispatch(ctx, "pdf", toolCallId, PDF_ACK, input)),
		},
	};
	if (ctx.animationAvailable?.()) {
		tools.animation = {
			name: "animation",
			label: "animation",
			description: ANIMATION_DESCRIPTION,
			parameters: animationInputSchema,
			execute: serverExecute("animation", animationInputSchema, (input, { toolCallId }) =>
				dispatch(ctx, "animation", toolCallId, ANIMATION_ACK, input),
			),
		};
	}
	if (ctx.workContextAvailable?.()) {
		tools.work_context = {
			name: "work_context",
			label: "work_context",
			description: WORK_CONTEXT_DESCRIPTION,
			parameters: workContextInputSchema,
			execute: serverExecute("work_context", workContextInputSchema, (input, { toolCallId }) =>
				ctx.jobStore
					.listJobs(ctx.chatId)
					.some((j) => j.kind === "work_context" && j.toolCallId !== toolCallId)
					? WORK_CONTEXT_ALREADY_ASKED
					: dispatch(ctx, "work_context", toolCallId, WORK_CONTEXT_ACK, input),
			),
		};
	}
	return tools;
}

export type ResearchInput = Static<typeof researchInputSchema>;
export type DemoInput = Static<typeof demoInputSchema>;
export type VisualInput = Static<typeof visualInputSchema>;
export type PdfInput = Static<typeof pdfInputSchema>;
export type AnimationInput = Static<typeof animationInputSchema>;
export type WorkContextInput = Static<typeof workContextInputSchema>;
/** Any job tool's input (the spawn seam's payload). */
export type JobInput = ResearchInput | DemoInput | VisualInput | PdfInput | AnimationInput | WorkContextInput;
