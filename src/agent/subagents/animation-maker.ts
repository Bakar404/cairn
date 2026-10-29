import { randomUUID } from "node:crypto";
import type { Message, Tool, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { piEngineFor, type PiEngine } from "../models.ts";
import { providerEventObserver } from "../provider-events.ts";
import { releaseCopilotSessions } from "../copilot/index.ts";
import type { AnimationResult, AnimationToolInput } from "../../core/contracts.ts";
import { MANIM_MAX_SECONDS, type ManimRenderer } from "../../core/manim.ts";
import { FIGURE } from "../../core/figure-theme.ts";
import { providerSafePng } from "./headless.ts";
import { applyExactEdit, issueLines, layoutReport, lookMessage, nudgeMessage, streamOnce, textOf, toolCallsOf, toolText } from "./maker-kit.ts";

/**
 * The animation-maker sub-agent (M13): writes ONE short Manim scene from the
 * teacher's brief, previews it, LOOKS at the preview, iterates, and renders
 * the final MP4 into the chat's media. Manim runs in Docker behind the
 * ManimRenderer port (src/server/manim.ts); tests inject a fake.
 *
 * The visual maker's loop shape and doctrine (visual-maker.ts): one raw
 * model call per iteration, tool results written by this loop, and the
 * preview's contact sheet (the moments the scene settles into, then the
 * final frame) fed back as an image, with the renderer's layout check in
 * the tool result. Finishing while that check still reports problems in
 * the final scene earns one reminder per scene.
 * Nothing is delivered unlooked — finishing with an unpreviewed scene
 * previews it first, and the final render is always of the scene the model
 * last looked at. Out of turns, the newest scene a model call looked at
 * ships (a preview made on the last turn gets one more call to look at
 * it); with none, the failure names the last render error.
 *
 * Failure semantics: { title, video: null, notes: "FAILED: …" }.
 */

export interface AnimationMakerOptions {
	manim: ManimRenderer;
	/** The job's chat and id: the MP4 and its poster are saved as
	 *  data/media/<chatId>/<jobId>.mp4 and <jobId>-poster.png. */
	chatId: string;
	jobId: string;
	/** Test seam: scripted engine; production uses the animationMaker role. */
	engine?: PiEngine;
	/** Max model rounds (write/preview cycles + final answer). Default 14;
	 *  a preview made in the last round gets one extra call to look at it. */
	maxIterations?: number;
	/** Live activity-line callback (updates the job record). */
	onActivity?: (line: string) => void;
	/** Kills the run mid-call or mid-render. */
	abortSignal?: AbortSignal;
	/** Money channel: one call per loop iteration, folded into JobRecord.usage. */
	onUsage?: (usage: Usage) => void;
}

const INSTRUCTIONS = `You are an animation maker. You write ONE short, precise Manim animation that shows an idea
unfolding over time — a process, a transformation, a quantity changing, steps in order. You receive a
brief from the teacher listing the beats; it is everything you know. The animation plays silently in
the lesson, so any words the learner must read have to be on screen.

You do NOT decide what idea to show — the teacher already decided. Your job is a faithful, precise
animation of the brief, and above everything CORRECTNESS: no frame may assert anything false. An arrow
pointing the wrong way, a value that changes in the wrong direction, a step out of order is a failure
even if it renders cleanly.

Your three tools:
- write_scene({ code }) — write the complete scene file (overwrites the previous version).
- edit_scene({ old_text, new_text }) — a surgical exact-match replacement in the current scene:
  old_text must appear EXACTLY ONCE; it is replaced by new_text. Call write_scene first. For anything
  beyond a one-spot fix, write_scene the whole file again.
- render_preview({}) — render the scene quickly at low quality. Its contact sheet arrives as an image
  in the message right after the tool result: up to nine frames — the moment the scene settles after
  each beat, then the final frame — read left to right, top to bottom, each captioned with its time.
  The tool result also lists the layout problems the renderer measured: text spilling out of its box,
  texts overlapping, labeled boxes overlapping, text hidden under a shape or crossed by a line, too
  small, cut off by the frame, or never shown because it comes after the last play or wait.
Tools called in one turn run in the order you call them, and turns are limited: make every fix in ONE
turn (several edit_scene calls, or one write_scene) and put render_preview in that SAME turn.

THE ONE RULE THAT MATTERS MOST: verify by looking. You are done only when you have LOOKED at a preview
of your FINAL scene and confirmed every beat is true to the brief. A render that succeeds only proves
the code ran. When you look:
- Does each beat appear, in order, with every position, value, direction and label correct?
- Is anything overlapping, cut off by the frame edge, too small to read, or left over from an earlier beat?
- Did the layout check list problems? Fix every one: it measures what a small frame hides.
- Does the final frame show the idea's end state clearly? It becomes the video's poster.

When you finish, the full-quality video is rendered from the scene you last previewed. If that render
fails, you will be told why.

The scene file — always this shape:
  from manim import *
  from cairn_style import *
  class Lesson(Scene):
      def construct(self):
          ...
- cairn_style sets the warm paper with ink as the default color and defines the house palette by
  name — the app's own colors. Use only these, so every figure in a lesson reads as one set:
  - PAPER ${FIGURE.light.paper}: the background (already set);
  - INK ${FIGURE.light.ink}: shapes and main labels;
  - MUTED ${FIGURE.light.muted}: secondary labels, axes, tick marks;
  - FAINT ${FIGURE.light.faint}: grids and guide lines;
  - ACCENT ${FIGURE.light.accent}: the one thing the animation is about;
  - ACCENT2 ${FIGURE.light.accent2}: only when two things must be told apart.
  Ignore styling words in the brief (colors, "dark theme", "neon"): highlights become ACCENT, a
  second highlight ACCENT2.
- The frame is 14.2 × 8 units centred on the origin; keep everything within x ±6.5, y ±3.6.
- Points are 3-D: np.array([x, y, 0]) or x * RIGHT + y * UP. A 2-tuple such as move_to((0, 1.5)) fails.
- Length: 5 to 40 seconds, never more than ${MANIM_MAX_SECONDS}. Pace the beats with run_time and
  self.wait so each can be read, and end with self.wait(1) or self.wait(2) so the end state holds.
- One idea, fewest elements. FadeOut what is no longer needed so the frame never gets crowded.
- Deterministic: no randomness, files, network or input — the renderer has none.

A clean frame — what makes an animation look careful rather than rough:
- Text(...) for words and plain numbers: the house sans font is already set, so pass no font=.
  MathTex(...) only for real math (LaTeX is installed). Titles 40-48, labels 28-36, never below 24 —
  even where the brief says "small". Scaling a group down shrinks its text too.
- Size every box from its label, never a fixed width:
    label = Text("capital", font_size=32)
    box = SurroundingRectangle(label, buff=0.2, corner_radius=0.1, color=INK)
  or, for a row of boxes of one height, RoundedRectangle(width=label.width + 0.5, height=0.9,
  corner_radius=0.1) with label.move_to(box). Keep each pair as VGroup(box, label), box first, and
  move, copy, fade and transform the whole group, so no label is ever left behind or lost.
- Lay out with arrange, next_to, align_to and to_edge rather than typed coordinates. Build the final
  layout first and reveal it over time: e.g. create all eight token boxes, arrange the whole row, show
  the first five, and bring each later one in as it arrives — the row never runs off the frame or needs
  re-centering or shrinking. If a group is wider than 12 units, scale_to_fit_width(12) before showing it.
- Transform(a, b) reshapes a into b and leaves a on screen (b itself is never added: keep using a);
  ReplacementTransform(a, b) leaves b on screen; TransformFromCopy(a, b) keeps a and adds b.
- One caption slot, at to_edge(DOWN, buff=0.5). Change the caption with ReplacementTransform(old, new),
  never by writing a second one on top.
- Put each value next to what it measures — value.next_to(bar, UP, buff=0.1) — and grow bars with
  GrowFromEdge(bar, DOWN).
- Indicate, Circumscribe and Flash already use the accent. After each beat, hold 0.5 to 1.5 s with
  self.wait so it can be read.

Your FINAL message: 1-2 sentences of notes for the teacher (what the animation shows and any caveats) —
NEVER the code itself. If you genuinely cannot make a correct animation of the brief, say exactly that
in your final message and why.`;

const LOOK_MESSAGE =
	"Here is the contact sheet of your preview — inspect every frame critically (order of beats, positions, labels, clipping, readability):";
const UNLOOKED_FINISH_MESSAGE =
	"You finished without looking at a preview of your final scene. Here is its contact sheet. If every beat is correct and clean, reply with just your notes; otherwise fix the scene and preview again.";
const OUT_OF_TURNS_MESSAGE =
	"That was your last turn to change the scene, so this is your final preview. Here is its contact sheet. Reply with just your notes for the teacher: what the animation shows, and anything in it that is still wrong.";
const LIMIT_NOTE = "Iteration limit reached — delivering the last previewed animation.";
const EARLIER_VERSION_NOTE =
	"Iteration limit reached — delivering the last version the maker looked at; it ran out of turns before looking at its later changes.";
const LAYOUT_GATE_MESSAGE = "Before you finish: the layout check still reports these problems in your final scene:";
const LAYOUT_GATE_ASK =
	"Fix them and preview again — or, if one is deliberate, reply with your notes again and say why.";

const SCENE_EDIT = { write: "write_scene", render: "render_preview", noun: "scene" };

/** A render error on one line for the job's notes, keeping its end (where
 *  Python's exception is). */
function briefError(error: string): string {
	const flat = error.replace(/\s+/g, " ").trim();
	return flat.length > 300 ? `…${flat.slice(-300)}` : flat;
}

/** The wire declarations: this loop executes them itself (the preview
 *  feeds the image-in-the-loop message), so they carry no execute. */
export function createAnimationTools(): Record<string, Tool> {
	return {
		write_scene: {
			name: "write_scene",
			description:
				"Write the complete Manim scene file for the animation (overwrites any previous version). It must define class Lesson(Scene).",
			parameters: Type.Object({
				code: Type.String({ description: "The complete Python file: from manim import *, from cairn_style import *, class Lesson(Scene)." }),
			}),
		},
		edit_scene: {
			name: "edit_scene",
			description:
				"Replace one exact spot in the current scene: old_text must appear EXACTLY ONCE and is replaced by new_text. Call write_scene first. For larger changes, write_scene the whole file.",
			parameters: Type.Object({
				old_text: Type.String({ description: "The exact text to replace — must match exactly once in the current scene." }),
				new_text: Type.String({ description: "The replacement text." }),
			}),
		},
		render_preview: {
			name: "render_preview",
			description:
				"Render the current scene at low quality and show you a contact sheet of the moments it settles into, then its final frame, with its length and any layout problems the renderer measured. No arguments.",
			parameters: Type.Object({}),
		},
	};
}

export async function runAnimationMaker(input: AnimationToolInput, opts: AnimationMakerOptions): Promise<AnimationResult> {
	const title = input.title.trim() || "Animation";
	const brief = input.brief.trim() || "(no brief)";
	const maxIterations = opts.maxIterations ?? 14;
	const failed = (why: string): AnimationResult => ({ title, video: null, notes: `FAILED: ${why}` });

	const status = await opts.manim.status();
	if (status.state !== "ready") return failed(status.reason);

	const toolDeclarations = Object.values(createAnimationTools());
	const engine = opts.engine ?? piEngineFor("animationMaker");
	const reasoning = engine.level;
	const sessionId = randomUUID();
	const prompt = [
		`Brief for ONE short animation titled "${title}" (from the teacher, verbatim — it is everything you know):`,
		brief,
		"",
		`Write the scene, preview it, look at it, iterate until correct, then finish with your notes. You have ${maxIterations} turns (a turn is one reply, however many tools it calls).`,
	].join("\n");

	let messages: Message[] = [{ role: "user", content: prompt, timestamp: Date.now() }];
	let currentScene: string | null = null;
	/** The scene shown in the latest preview (null = none since the last change). */
	let previewed: string | null = null;
	/** The scene whose contact sheet a model call has received. */
	let looked: string | null = null;
	/** The newest scene any model call has looked at (survives later changes). */
	let lastLooked: string | null = null;
	/** The latest render's error, cleared by a successful preview. */
	let lastError: string | null = null;
	/** The layout check's findings for the previewed scene. */
	let previewIssues: string[] = [];
	/** The scene a finish was last reminded of its layout problems (once per scene). */
	let remindedScene: string | null = null;
	let finalText = "";

	const render = (code: string, mode: "preview" | "final") =>
		opts.manim.render({
			chatId: opts.chatId,
			jobId: opts.jobId,
			code,
			mode,
			...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
		});

	/** Preview a scene: the contact sheet, length and layout findings, or
	 *  what went wrong (kept as lastError until a preview succeeds). */
	const preview = async (code: string): Promise<{ png: Buffer; durationSec: number; issues: string[] } | { error: string }> => {
		const out = await render(code, "preview");
		const durationSec = out.durationSec ?? 0;
		if (!out.ok || !out.pngBase64) {
			lastError = out.error ?? "the preview returned no picture";
		} else if (durationSec > MANIM_MAX_SECONDS) {
			lastError = `the animation runs ${durationSec.toFixed(1)} s and the limit is ${MANIM_MAX_SECONDS} s. Shorten it: fewer beats, shorter run_time and waits.`;
		} else {
			lastError = null;
			return { png: providerSafePng(Buffer.from(out.pngBase64, "base64")), durationSec, issues: out.issues ?? [] };
		}
		return { error: lastError };
	};

	/** Render the final video of the scene the model last looked at. */
	const deliver = async (code: string, notes: string): Promise<AnimationResult | { error: string }> => {
		opts.onActivity?.("rendering the final video");
		const out = await render(code, "final");
		if (!out.ok || !out.video) return { error: out.error ?? "the render returned no video" };
		return {
			title,
			video: out.video,
			...(out.poster ? { poster: out.poster } : {}),
			...(out.durationSec !== undefined ? { durationSec: out.durationSec } : {}),
			...(notes ? { notes } : {}),
		};
	};

	try {
		for (let iteration = 0; iteration < maxIterations; iteration++) {
			// This call receives every contact sheet added so far.
			looked = previewed;
			if (looked) lastLooked = looked;
			const lastTurn = iteration === maxIterations - 1;
			const result = await streamOnce(
				engine,
				INSTRUCTIONS,
				messages,
				toolDeclarations,
				sessionId,
				reasoning,
				opts.abortSignal,
				providerEventObserver(opts.chatId, "job:animationMaker"),
			);
			// Money channel: each iteration is one model call.
			opts.onUsage?.(result.usage);
			messages = [...messages, result];

			const toolCalls = toolCallsOf(result);
			if (toolCalls.length === 0) {
				finalText = textOf(result);
				if (!currentScene) {
					return failed(`the maker never wrote a scene.${finalText ? ` (${finalText.slice(0, 300)})` : ""}`);
				}
				// Doctrine gate: never deliver an unlooked animation. Preview the
				// final scene now and make the model look before accepting.
				if (previewed !== currentScene) {
					opts.onActivity?.("render_preview: previewing the final scene");
					const shot = await preview(currentScene);
					if ("error" in shot) {
						messages = [
							...messages,
							nudgeMessage(
								`You finished without previewing your final scene, and previewing it failed:\n${shot.error}\nFix the scene and preview again.`,
							),
						];
						continue;
					}
					previewed = currentScene;
					previewIssues = shot.issues;
					// This look carries the layout check: it is the scene's reminder.
					if (shot.issues.length) remindedScene = currentScene;
					const look = lastTurn ? OUT_OF_TURNS_MESSAGE : UNLOOKED_FINISH_MESSAGE;
					messages = [
						...messages,
						lookMessage(`${look} (${shot.durationSec.toFixed(1)} s)${layoutReport(shot.issues)}`, shot.png),
					];
					continue;
				}
				// Layout gate: the check still reports problems in the final scene.
				// One reminder per scene; a deliberate choice is the model's call.
				if (previewIssues.length && remindedScene !== currentScene && !lastTurn) {
					remindedScene = currentScene;
					messages = [...messages, nudgeMessage(`${LAYOUT_GATE_MESSAGE}\n${issueLines(previewIssues)}\n${LAYOUT_GATE_ASK}`)];
					continue;
				}
				const out = await deliver(currentScene, finalText);
				if ("error" in out) {
					// The model must fix the scene and look again before the next try;
					// out of turns, this scene is not tried again.
					previewed = null;
					lastLooked = null;
					lastError = out.error;
					messages = [
						...messages,
						nudgeMessage(`The full-quality render failed:\n${out.error}\nFix the scene, preview it again, then finish.`),
					];
					continue;
				}
				return out;
			}

			const toolResults: ToolResultMessage[] = [];
			// The latest contact sheet, appended AFTER the tool results.
			let sheet: Buffer | null = null;
			for (const call of toolCalls) {
				if (call.name === "write_scene") {
					const code = (call.arguments as { code?: unknown }).code;
					if (typeof code !== "string" || !/class\s+Lesson\s*\(/.test(code)) {
						toolResults.push(
							toolText(call.id, call.name, "ERROR: expected the complete scene file in the `code` field, defining class Lesson(Scene)."),
						);
						continue;
					}
					currentScene = code;
					opts.onActivity?.(`write_scene: ${(code.length / 1024).toFixed(1)} KB`);
					toolResults.push(toolText(call.id, call.name, `Saved (${code.length} bytes). Call render_preview to look at it.`));
				} else if (call.name === "edit_scene") {
					const edit = applyExactEdit(currentScene, call.arguments, SCENE_EDIT);
					toolResults.push(toolText(call.id, call.name, edit.reply));
					if (edit.next === null) continue;
					currentScene = edit.next;
					opts.onActivity?.("edit_scene: applied");
				} else if (call.name === "render_preview") {
					if (!currentScene) {
						toolResults.push(toolText(call.id, call.name, "ERROR: nothing to preview — call write_scene first."));
						continue;
					}
					opts.onActivity?.("render_preview: rendering");
					const shot = await preview(currentScene);
					if ("error" in shot) {
						opts.onActivity?.("render_preview: render error");
						toolResults.push(toolText(call.id, call.name, `RENDER ERROR: ${shot.error}\nFix the scene and preview again.`));
						continue;
					}
					sheet = shot.png;
					previewed = currentScene;
					previewIssues = shot.issues;
					const flagged = shot.issues.length ? ` (${shot.issues.length} layout problem${shot.issues.length === 1 ? "" : "s"})` : "";
					opts.onActivity?.(`render_preview: inspecting a ${shot.durationSec.toFixed(1)} s preview${flagged}`);
					toolResults.push(
						toolText(
							call.id,
							call.name,
							`Rendered — ${shot.durationSec.toFixed(1)} s long. The contact sheet follows in the next message. Look at it.${layoutReport(shot.issues)}`,
						),
					);
				} else {
					toolResults.push(toolText(call.id, call.name, `ERROR: unknown tool "${call.name}". Use write_scene, edit_scene, or render_preview.`));
				}
			}
			// Message order: assistant tool-calls → tool results → contact sheet.
			messages = [...messages, ...toolResults];
			if (sheet) messages = [...messages, lookMessage(lastTurn ? OUT_OF_TURNS_MESSAGE : LOOK_MESSAGE, sheet)];
		}

		// Out of turns. A preview of the current scene made on the last turn
		// gets one more call, to look at it and write the notes; any tool calls
		// in its reply are not run.
		if (currentScene && previewed === currentScene && looked !== currentScene) {
			opts.onActivity?.("looking at the final preview");
			const result = await streamOnce(
				engine,
				INSTRUCTIONS,
				messages,
				toolDeclarations,
				sessionId,
				reasoning,
				opts.abortSignal,
				providerEventObserver(opts.chatId, "job:animationMaker"),
			);
			opts.onUsage?.(result.usage);
			lastLooked = currentScene;
			finalText = toolCallsOf(result).length === 0 ? textOf(result) : "";
		}
		// Deliver the newest scene a model call looked at — never an unlooked one.
		if (lastLooked) {
			const notes = lastLooked === currentScene ? finalText || LIMIT_NOTE : EARLIER_VERSION_NOTE;
			const out = await deliver(lastLooked, notes);
			if (!("error" in out)) return out;
			return failed(`iteration limit (${maxIterations}) reached, and the final render failed — ${out.error}`);
		}
		const why = lastError ? ` Last render error: ${briefError(lastError)}` : "";
		return failed(`iteration limit (${maxIterations}) reached without an animation the maker had looked at.${why}`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return failed(`the maker crashed — ${msg}`);
	} finally {
		releaseCopilotSessions(sessionId);
	}
}
