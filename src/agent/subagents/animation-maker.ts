import { randomUUID } from "node:crypto";
import type { Message, Tool, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { piEngineFor, type PiEngine } from "../models.ts";
import { providerEventObserver } from "../provider-events.ts";
import { releaseCopilotSessions } from "../copilot/index.ts";
import type { AnimationResult, AnimationToolInput } from "../../core/contracts.ts";
import { MANIM_MAX_SECONDS, type ManimRenderer } from "../../core/manim.ts";
import { providerSafePng } from "./headless.ts";
import { applyExactEdit, lookMessage, nudgeMessage, streamOnce, textOf, toolCallsOf, toolText } from "./maker-kit.ts";

/**
 * The animation-maker sub-agent (M13): writes ONE short Manim scene from the
 * teacher's brief, previews it, LOOKS at the preview, iterates, and renders
 * the final MP4 into the chat's media. Manim runs in Docker behind the
 * ManimRenderer port (src/server/manim.ts); tests inject a fake.
 *
 * The visual maker's loop shape and doctrine (visual-maker.ts): one raw
 * model call per iteration, tool results written by this loop, and the
 * preview's contact sheet (six frames, start to end) fed back as an image.
 * Nothing is delivered unlooked — finishing with an unpreviewed scene
 * previews it first, and the final render is always of the scene the model
 * last looked at.
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
	/** Max model rounds (write/preview cycles + final answer). Default 10. */
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
  in the message right after the tool result: six frames in a 3 × 2 grid, read left to right, top to
  bottom, each captioned with its time; the last one is the final frame.

THE ONE RULE THAT MATTERS MOST: verify by looking. You are done only when you have LOOKED at a preview
of your FINAL scene and confirmed every beat is true to the brief. A render that succeeds only proves
the code ran. When you look:
- Does each beat appear, in order, with every position, value, direction and label correct?
- Is anything overlapping, cut off by the frame edge, too small to read, or left over from an earlier beat?
- Does the final frame show the idea's end state clearly? It becomes the video's poster.

When you finish, the full-quality video is rendered from the scene you last previewed. If that render
fails, you will be told why.

The scene file — always this shape:
  from manim import *
  from cairn_style import *
  class Lesson(Scene):
      def construct(self):
          ...
- cairn_style sets white paper with ink as the default color and defines the house palette by name.
  Use only these colors, so every figure in a lesson reads as one set:
  - PAPER #FFFFFF: the background (already set);
  - INK #1F1F1F: shapes and main labels;
  - MUTED #6B6B6B: secondary labels, axes, tick marks;
  - FAINT #D9D9D9: grids and guide lines;
  - ACCENT #2563EB: the one thing the animation is about;
  - ACCENT2 #EA580C: only when two things must be told apart.
- Text(...) for words, MathTex(...) for math (LaTeX is installed). Generous sizes.
- The frame is 14.2 × 8 units centred on the origin; keep everything within x ±6.5, y ±3.6.
- Length: 5 to 40 seconds, never more than ${MANIM_MAX_SECONDS}. Pace the beats with run_time and
  self.wait so each can be read, and end with self.wait(1) or self.wait(2) so the end state holds.
- One idea, fewest elements. FadeOut what is no longer needed so the frame never gets crowded.
- Deterministic: no randomness, files, network or input — the renderer has none.

Your FINAL message: 1-2 sentences of notes for the teacher (what the animation shows and any caveats) —
NEVER the code itself. If you genuinely cannot make a correct animation of the brief, say exactly that
in your final message and why.`;

const LOOK_MESSAGE =
	"Here is the contact sheet of your preview — inspect every frame critically (order of beats, positions, labels, clipping, readability):";
const UNLOOKED_FINISH_MESSAGE =
	"You finished without looking at a preview of your final scene. Here is its contact sheet. If every beat is correct and clean, reply with just your notes; otherwise fix the scene and preview again.";

const SCENE_EDIT = { write: "write_scene", render: "render_preview", noun: "scene" };

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
				"Render the current scene at low quality and show you a contact sheet of six frames, start to end, with its length. No arguments.",
			parameters: Type.Object({}),
		},
	};
}

export async function runAnimationMaker(input: AnimationToolInput, opts: AnimationMakerOptions): Promise<AnimationResult> {
	const title = input.title.trim() || "Animation";
	const brief = input.brief.trim() || "(no brief)";
	const maxIterations = opts.maxIterations ?? 10;
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
		"Write the scene, preview it, look at it, iterate until correct, then finish with your notes.",
	].join("\n");

	let messages: Message[] = [{ role: "user", content: prompt, timestamp: Date.now() }];
	let currentScene: string | null = null;
	/** The scene shown in the latest preview (null = none since the last change). */
	let previewed: string | null = null;
	/** The scene whose contact sheet a model call has received. */
	let looked: string | null = null;
	let finalText = "";

	const render = (code: string, mode: "preview" | "final") =>
		opts.manim.render({
			chatId: opts.chatId,
			jobId: opts.jobId,
			code,
			mode,
			...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
		});

	/** Preview a scene: the contact sheet and length, or what went wrong. */
	const preview = async (code: string): Promise<{ png: Buffer; durationSec: number } | { error: string }> => {
		const out = await render(code, "preview");
		if (!out.ok || !out.pngBase64) return { error: out.error ?? "the preview returned no picture" };
		const durationSec = out.durationSec ?? 0;
		if (durationSec > MANIM_MAX_SECONDS) {
			return {
				error: `the animation runs ${durationSec.toFixed(1)} s and the limit is ${MANIM_MAX_SECONDS} s. Shorten it: fewer beats, shorter run_time and waits.`,
			};
		}
		return { png: providerSafePng(Buffer.from(out.pngBase64, "base64")), durationSec };
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
					messages = [...messages, lookMessage(`${UNLOOKED_FINISH_MESSAGE} (${shot.durationSec.toFixed(1)} s)`, shot.png)];
					continue;
				}
				const out = await deliver(currentScene, finalText);
				if ("error" in out) {
					// The model must fix the scene and look again before the next try.
					previewed = null;
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
					opts.onActivity?.(`render_preview: inspecting a ${shot.durationSec.toFixed(1)} s preview`);
					toolResults.push(
						toolText(
							call.id,
							call.name,
							`Rendered — ${shot.durationSec.toFixed(1)} s long. The contact sheet follows in the next message. Look at it.`,
						),
					);
				} else {
					toolResults.push(toolText(call.id, call.name, `ERROR: unknown tool "${call.name}". Use write_scene, edit_scene, or render_preview.`));
				}
			}
			// Message order: assistant tool-calls → tool results → contact sheet.
			messages = [...messages, ...toolResults];
			if (sheet) messages = [...messages, lookMessage(LOOK_MESSAGE, sheet)];
		}

		// Iteration limit: deliver the last scene only if a model call saw its
		// contact sheet. A preview made on the last turn was never looked at.
		if (currentScene && previewed === currentScene && looked === currentScene) {
			const out = await deliver(currentScene, finalText || "Iteration limit reached — delivering the last previewed animation.");
			if (!("error" in out)) return out;
			return failed(`iteration limit (${maxIterations}) reached, and the final render failed — ${out.error}`);
		}
		return failed(`iteration limit (${maxIterations}) reached without an animation the maker had looked at.`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return failed(`the maker crashed — ${msg}`);
	} finally {
		releaseCopilotSessions(sessionId);
	}
}
