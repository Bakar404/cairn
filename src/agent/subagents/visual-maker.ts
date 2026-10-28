import { randomUUID } from "node:crypto";
import type { Message, Tool, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { piEngineFor, type PiEngine } from "../models.ts";
import { providerEventObserver } from "../provider-events.ts";
import { releaseCopilotSessions } from "../copilot/index.ts";
import type { MediaRef, VisualResult } from "../../core/contracts.ts";
import type { ManimRenderer } from "../../core/manim.ts";
import { getHeadless, providerSafePng, type HeadlessApi } from "./headless.ts";
import { applyExactEdit, layoutReport, lookMessage, nudgeMessage, streamOnce, textOf, toolCallsOf, toolText } from "./maker-kit.ts";

/**
 * The visual-maker sub-agent (vision §2.5): authors ONE precise SVG from a
 * brief, renders it to a PNG with the same rasterizer the transcript
 * will use, LOOKS at the
 * result, and iterates until correct — a direct port of the vault POC's
 * svg-maker doctrine ("the one rule that matters: verify by looking").
 *
 * LOOP SHAPE (decided in the W6 brief): hand-rolled with generateText + a
 * messages array, because the loop must feed an IMAGE back to the model after
 * each render. write_svg / render_svg are declared WITHOUT execute — when the
 * model calls them generateText stops with the tool calls, and this loop
 * appends the tool results itself, followed by a user message containing the
 * rendered PNG as a file part ("Here is the current render"). ToolLoopAgent's
 * execute-tool plumbing can't express that image-in-the-loop shape cleanly.
 *
 * Doctrine enforcement in code: if the model tries to finish while the
 * current SVG has never been rendered (or changed since its last render), the
 * loop renders it anyway, shows the image, and asks the model to look before
 * finishing. Nothing is delivered without having been looked at.
 *
 * Failure semantics mirror the demo-builder: { svg: "", notes: "FAILED: …" }.
 *
 * MANIM STILLS (M13): when the Manim renderer is ready (and the job's chat
 * and id are known), three more tools let the maker draw the figure as a
 * Manim scene instead — for typeset math and Manim's geometry. The scene's
 * final frame is rendered in Docker, saved to the chat's media, and looked
 * at like an SVG render; the result is then { svg: "", png }. Whichever
 * medium the maker wrote last is the one delivered.
 */

export interface VisualMakerInput {
	brief: string;
}

export interface VisualMakerOptions {
	/** Test seam: scripted engine; production uses the visualMaker role. */
	engine?: PiEngine;
	headless?: HeadlessApi;
	/** Max model rounds (write/render cycles + final answer). Default 8. */
	maxIterations?: number;
	/** Live activity-line callback (updates the job record). */
	onActivity?: (line: string) => void;
	/** Kills the run mid-model-call (2026-09 real-kill abort semantics). */
	abortSignal?: AbortSignal;
	/** Money channel: one call per loop iteration (streamSimple), folded
	 * into JobRecord.usage. */
	onUsage?: (usage: Usage) => void;
	/** The job's chat: the raw provider-event recording key
	 *  (LH_PROVIDER_EVENTS=1), and with jobId where a Manim still is saved. */
	chatId?: string;
	/** The job id a Manim still is saved under (data/media/<chatId>/<jobId>.png). */
	jobId?: string;
	/** The Manim renderer: when present and ready (and chatId + jobId are
	 *  set), the maker may draw the figure as a Manim scene. */
	manim?: ManimRenderer;
}

const INSTRUCTIONS = `You are a visual maker — a diagram author + renderer for precise, spatial figures. You
receive a brief describing ONE idea that needs exact placement (coordinate geometry, number lines,
vectors, function plots, physical layouts — things auto-layout diagrams cannot express), and you return
ONE clean, correct SVG. You never see the lesson; the brief is everything you know.

You do NOT decide what idea to show — the teacher already decided. Your job is faithful, precise
composition, and above everything CORRECTNESS: the picture must not assert anything false. A right-angle
mark on the wrong corner, a vector pointing the wrong way, a point plotted at the wrong coordinate is a
failure even if it renders cleanly.

Your three tools:
- write_svg({ svg }) — write the complete <svg>…</svg> source (overwrites the previous version).
- edit_svg({ old_text, new_text }) — a surgical exact-match replacement in the current SVG:
  old_text must appear EXACTLY ONCE; it is replaced by new_text. Call write_svg first. For anything
  beyond a one-spot fix (new elements, restructured layout), write_svg the whole document again.
- render_svg({}) — rasterize the current SVG to a PNG. The render arrives as an image in the
  message right after the tool result.

THE ONE RULE THAT MATTERS MOST: verify by looking. You are done only when you have LOOKED at the
rendered PNG and confirmed it is true to the brief. Rendering success only proves the SVG parsed; it
says nothing about whether the geometry is right or the picture is readable. When you look:

- Is every coordinate, angle, direction, and proportion actually correct? Re-derive the geometry if unsure.
- Are labels placed clearly, not overlapping lines or each other?
- Is anything clipped by the viewBox, too small to read, or cramped?
- Would a learner instantly read the intended idea from this picture alone?

Workflow: plan the coordinate space (viewBox + margins, nothing touching the edges) → write_svg →
render_svg → LOOK critically → fix (edit_svg for one-spot fixes, write_svg otherwise) and re-render
until correct and clean. Never finish without having looked at a render of your FINAL SVG.

SVG requirements:
- A complete <svg> with explicit width/height AND a matching viewBox.
- The house palette, so every figure in a lesson reads as one set — no other colors:
  - paper #FFFFFF: a full-size background <rect>;
  - ink #1F1F1F: strokes, shapes, and main labels;
  - muted #6B6B6B: secondary labels, axes, tick marks;
  - faint #D9D9D9: grids and guide lines;
  - accent #2563EB: the one thing the figure is about;
  - second accent #EA580C: only when two things must be told apart.
- Sans-serif labels at generous sizes; arrows end in filled arrowheads (a <marker>).
- One idea, fewest elements — sparse and large beats busy and tiny.
- Draw only what the brief specifies; never invent data, values, or shapes to fill space.
- Plain, clean styling. An explanatory diagram, not art.

Your FINAL message: 1-2 sentences of notes for the teacher (what the figure shows, any caveats) —
NEVER the SVG source itself. If you genuinely cannot make a correct picture of the brief, say exactly
that in your final message and why.`;

/** Appended to INSTRUCTIONS when the Manim renderer is ready. */
const MANIM_INSTRUCTIONS = `

A SECOND MEDIUM — a Manim still. Three more tools draw the figure with Manim Community v0.22
(Python) instead of SVG; the scene's FINAL FRAME becomes the figure (1920×1080):
- write_manim({ code }) — write the complete scene file (overwrites the previous version).
- edit_manim({ old_text, new_text }) — the same exact-once replacement, in the scene.
- render_manim({}) — render the final frame; the PNG arrives as an image, like render_svg's, and the
  tool result lists any layout problems the renderer measured (fix every one).

Use Manim when the figure needs typeset math (MathTex/Tex — LaTeX is installed) or Manim's
axes, graphs and geometry; use SVG for everything else. ONE medium per figure: whichever you
wrote or edited last is the one delivered, and the same looking rule applies to it.

The scene file — always this shape (build the picture with self.add; nothing needs to move):
  from manim import *
  from cairn_style import *
  class Lesson(Scene):
      def construct(self):
          ...
- cairn_style sets the white paper with ink as the default color and defines the palette
  above by name: PAPER, INK, MUTED, FAINT, ACCENT, ACCENT2 — use only those.
- The frame is 14.2 × 8 units centred on the origin; keep everything within x ±6.5, y ±3.6.
- Text(...) for words: the house sans font is already set, so pass no font=. Labels 28-36, never
  below 24. Size each box from its label — SurroundingRectangle(label, buff=0.2, color=INK) or
  RoundedRectangle(width=label.width + 0.5, height=0.9) — and add the box before its label.
- No files, network or input — the renderer has none.`;

/** The wire declarations (pi-ai Tool, TypeBox parameters): this loop owns
 *  execution itself — write/edit dispatch inline below, render feeds the
 *  image-in-the-loop message — so the declarations carry no execute.
 *  `withManim` adds the Manim-still tools. */
export function createVisualTools(withManim = false): Record<string, Tool> {
	const tools: Record<string, Tool> = {
		write_svg: {
			name: "write_svg",
			description: "Write the complete SVG source for the figure (overwrites any previous version).",
			parameters: Type.Object({
				svg: Type.String({ description: 'Complete <svg xmlns="…">…</svg> markup.' }),
			}),
		},
		edit_svg: {
			name: "edit_svg",
			description:
				"Replace one exact spot in the current SVG: old_text must appear EXACTLY ONCE and is replaced by new_text. Call write_svg first. For larger changes, write_svg the whole document.",
			parameters: Type.Object({
				old_text: Type.String({ description: "The exact text to replace — must match exactly once in the current SVG." }),
				new_text: Type.String({ description: "The replacement text." }),
			}),
		},
		render_svg: {
			name: "render_svg",
			description: "Render the current SVG to a PNG and show it to you for inspection. No arguments.",
			parameters: Type.Object({}),
		},
	};
	if (!withManim) return tools;
	return {
		...tools,
		write_manim: {
			name: "write_manim",
			description:
				"Write the complete Manim scene file for the figure (overwrites any previous version). It must define class Lesson(Scene); the final frame is the figure.",
			parameters: Type.Object({
				code: Type.String({ description: "The complete Python file: from manim import *, from cairn_style import *, class Lesson(Scene)." }),
			}),
		},
		edit_manim: {
			name: "edit_manim",
			description:
				"Replace one exact spot in the current scene: old_text must appear EXACTLY ONCE and is replaced by new_text. Call write_manim first. For larger changes, write_manim the whole file.",
			parameters: Type.Object({
				old_text: Type.String({ description: "The exact text to replace — must match exactly once in the current scene." }),
				new_text: Type.String({ description: "The replacement text." }),
			}),
		},
		render_manim: {
			name: "render_manim",
			description: "Render the current scene's final frame to a PNG and show it to you for inspection. No arguments.",
			parameters: Type.Object({}),
		},
	};
}

const LOOK_MESSAGE =
	"Here is the current render of your SVG — inspect it critically (geometry, labels, clipping, readability):";
const UNLOOKED_FINISH_MESSAGE =
	"You finished without looking at a render of your final SVG. Above is its render. If it is correct and clean, reply with just your notes; otherwise call write_svg with fixes and render again.";
const MANIM_LOOK_MESSAGE =
	"Here is the final frame of your scene — inspect it critically (geometry, labels, clipping, readability):";
const MANIM_UNLOOKED_FINISH_MESSAGE =
	"You finished without looking at a render of your final scene. Here is its final frame. If it is correct and clean, reply with just your notes; otherwise fix the scene and render again.";

export async function runVisualMaker(input: VisualMakerInput, opts: VisualMakerOptions = {}): Promise<VisualResult> {
	const headless = opts.headless ?? getHeadless();
	const brief = input.brief.trim() || "(no brief)";
	const maxIterations = opts.maxIterations ?? 8;

	const reason = headless.unavailableReason();
	if (reason) {
		return { svg: "", notes: `FAILED: ${reason}` };
	}

	// Manim stills need the renderer AND a place to save them (the job's chat).
	const manim = opts.manim && opts.chatId && opts.jobId && opts.manim.ready() ? opts.manim : undefined;
	const tools = createVisualTools(Boolean(manim));
	const toolDeclarations = Object.values(tools);
	const instructions = manim ? INSTRUCTIONS + MANIM_INSTRUCTIONS : INSTRUCTIONS;
	const engine = opts.engine ?? piEngineFor("visualMaker");
	// BYOK (owner, 2026-09-22): the level rides the injected engine — no
	// factory pin to consult (engine.level is the resolved/clamped value).
	const reasoning = engine.level;
	const sessionId = randomUUID();
	const prompt = [
		"Brief for ONE precise figure (from the teacher, verbatim — it is everything you know):",
		brief,
		"",
		"Author the SVG, render it, look at it, iterate until correct, then finish with your notes.",
	].join("\n");

	let messages: Message[] = [{ role: "user", content: prompt, timestamp: Date.now() }];
	let currentSvg: string | null = null;
	/** The svg shown in the most recent render (null = never rendered). */
	let renderedSvg: string | null = null;
	/** The Manim scene, the scene shown in the latest still, and that still. */
	let currentScene: string | null = null;
	let renderedScene: string | null = null;
	let still: MediaRef | null = null;
	/** The scene whose still a model call has received. */
	let lookedScene: string | null = null;
	/** The medium written or edited last — the one delivered. */
	let medium: "svg" | "manim" = "svg";
	let finalText = "";

	/** Render the scene's final frame: the PNG to look at, the saved still
	 *  and the layout check's findings, or the error (the caller records
	 *  what was rendered). */
	const renderStill = async (code: string): Promise<{ png: Buffer; still: MediaRef; issues: string[] } | { error: string }> => {
		if (!manim || !opts.chatId || !opts.jobId) return { error: "Manim isn't available." };
		const out = await manim.render({
			chatId: opts.chatId,
			jobId: opts.jobId,
			code,
			mode: "still",
			...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
		});
		if (!out.ok || !out.still || !out.pngBase64) return { error: out.error ?? "the render returned no picture" };
		return { png: providerSafePng(Buffer.from(out.pngBase64, "base64")), still: out.still, issues: out.issues ?? [] };
	};

	try {
		for (let iteration = 0; iteration < maxIterations; iteration++) {
			// One model call per iteration (streamSimple, no agent loop — this
			// loop owns tool execution and the image-in-the-loop injection).
			// This call receives every still added so far.
			lookedScene = renderedScene;
			const result = await streamOnce(
				engine,
				instructions,
				messages,
				toolDeclarations,
				sessionId,
				reasoning,
				opts.abortSignal,
				opts.chatId ? providerEventObserver(opts.chatId, "job:visualMaker") : undefined,
			);
			// Money channel: each iteration is one model call.
			opts.onUsage?.(result.usage);
			messages = [...messages, result];

			const toolCalls = toolCallsOf(result);
			if (toolCalls.length === 0) {
				finalText = textOf(result);
				// Doctrine gate (Manim): never deliver an unlooked still. Render the
				// final scene now and make the model look; a failed render goes back
				// to the model to fix.
				if (medium === "manim" && currentScene && renderedScene !== currentScene) {
					const shot = await renderStill(currentScene);
					if ("error" in shot) {
						opts.onActivity?.("render_manim: render error");
						messages = [
							...messages,
							nudgeMessage(
								`You finished without looking at a render of your final scene, and rendering it failed:\n${shot.error}\nFix the scene and render again.`,
							),
						];
						continue;
					}
					opts.onActivity?.("render_manim: inspecting final render");
					still = shot.still;
					renderedScene = currentScene;
					messages = [...messages, lookMessage(MANIM_UNLOOKED_FINISH_MESSAGE + layoutReport(shot.issues), shot.png)];
					continue;
				}
				if (medium === "manim" && still) return { svg: "", png: still, notes: finalText || undefined };
				// Doctrine gate: never deliver an unlooked SVG. If the current SVG
				// changed since its last render (or was never rendered), show it now
				// and make the model look before accepting the finish.
				if (currentSvg && renderedSvg !== currentSvg) {
					let png: Buffer;
					try {
						png = await headless.renderSvg(currentSvg);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						return { svg: "", notes: `FAILED: rendering the final SVG failed — ${msg}` };
					}
					opts.onActivity?.("render_svg: inspecting final render");
					renderedSvg = currentSvg;
					messages = [...messages, lookMessage(UNLOOKED_FINISH_MESSAGE, png)];
					continue;
				}
				return finish(currentSvg, finalText);
			}

			const toolResults: ToolResultMessage[] = [];
			// Renders are appended as image messages AFTER the tool results (the
			// latest render per medium).
			let svgPng: Buffer | null = null;
			let stillPng: Buffer | null = null;
			for (const call of toolCalls) {
				if (call.name === "write_svg") {
					const svg = (call.arguments as { svg?: unknown }).svg;
					if (typeof svg !== "string" || !svg.includes("<svg")) {
						toolResults.push(toolText(call.id, call.name, "ERROR: expected a complete <svg>…</svg> document in the `svg` field."));
						continue;
					}
					currentSvg = svg;
					medium = "svg";
					opts.onActivity?.(`write_svg: ${(svg.length / 1024).toFixed(1)} KB`);
					toolResults.push(toolText(call.id, call.name, `Saved (${svg.length} bytes). Call render_svg to look at it.`));
				} else if (call.name === "edit_svg") {
					const edit = applyExactEdit(currentSvg, call.arguments, SVG_EDIT);
					toolResults.push(toolText(call.id, call.name, edit.reply));
					if (edit.next === null) continue;
					currentSvg = edit.next;
					medium = "svg";
					opts.onActivity?.("edit_svg: applied");
				} else if (call.name === "render_svg") {
					if (!currentSvg) {
						toolResults.push(toolText(call.id, call.name, "ERROR: nothing to render — call write_svg first."));
						continue;
					}
					try {
						const png = await headless.renderSvg(currentSvg);
						svgPng = png;
						renderedSvg = currentSvg;
						opts.onActivity?.("render_svg: inspecting render");
						toolResults.push(toolText(call.id, call.name, "Rendered — the PNG follows in the next message. Look at it."));
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						opts.onActivity?.("render_svg: render error");
						toolResults.push(toolText(call.id, call.name, `RENDER ERROR (the SVG may be malformed): ${msg}. Fix it with write_svg and render again.`));
					}
				} else if (manim && call.name === "write_manim") {
					const code = (call.arguments as { code?: unknown }).code;
					if (typeof code !== "string" || !/class\s+Lesson\s*\(/.test(code)) {
						toolResults.push(
							toolText(call.id, call.name, "ERROR: expected the complete scene file in the `code` field, defining class Lesson(Scene)."),
						);
						continue;
					}
					currentScene = code;
					medium = "manim";
					opts.onActivity?.(`write_manim: ${(code.length / 1024).toFixed(1)} KB`);
					toolResults.push(toolText(call.id, call.name, `Saved (${code.length} bytes). Call render_manim to look at it.`));
				} else if (manim && call.name === "edit_manim") {
					const edit = applyExactEdit(currentScene, call.arguments, MANIM_EDIT);
					toolResults.push(toolText(call.id, call.name, edit.reply));
					if (edit.next === null) continue;
					currentScene = edit.next;
					medium = "manim";
					opts.onActivity?.("edit_manim: applied");
				} else if (manim && call.name === "render_manim") {
					if (!currentScene) {
						toolResults.push(toolText(call.id, call.name, "ERROR: nothing to render — call write_manim first."));
						continue;
					}
					opts.onActivity?.("render_manim: rendering");
					const shot = await renderStill(currentScene);
					if ("error" in shot) {
						opts.onActivity?.("render_manim: render error");
						toolResults.push(toolText(call.id, call.name, `RENDER ERROR: ${shot.error}\nFix the scene and render again.`));
						continue;
					}
					stillPng = shot.png;
					still = shot.still;
					renderedScene = currentScene;
					opts.onActivity?.("render_manim: inspecting render");
					toolResults.push(
						toolText(
							call.id,
							call.name,
							`Rendered — the final frame follows in the next message. Look at it.${layoutReport(shot.issues)}`,
						),
					);
				} else {
					const known = manim
						? "write_svg, edit_svg, render_svg, write_manim, edit_manim, or render_manim"
						: "write_svg, edit_svg, or render_svg";
					toolResults.push(toolText(call.id, call.name, `ERROR: unknown tool "${call.name}". Use ${known}.`));
				}
			}
			// Message order: assistant tool-calls → tool results → render image(s).
			messages = [...messages, ...toolResults];
			if (svgPng) messages = [...messages, lookMessage(LOOK_MESSAGE, svgPng)];
			if (stillPng) messages = [...messages, lookMessage(MANIM_LOOK_MESSAGE, stillPng)];
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { svg: "", notes: `FAILED: the maker crashed — ${msg}` };
	} finally {
		releaseCopilotSessions(sessionId);
	}

	// Iteration limit: deliver the last written figure only if it was looked at.
	if (medium === "manim") {
		// A still rendered on the last turn was never looked at.
		if (still && currentScene && lookedScene === currentScene) {
			return { svg: "", png: still, notes: finalText || "Iteration limit reached — delivering the last verified still." };
		}
		return { svg: "", notes: `FAILED: iteration limit (${maxIterations}) reached without a verified figure.` };
	}
	if (currentSvg && renderedSvg === currentSvg) {
		return { svg: currentSvg, notes: finalText || "Iteration limit reached — delivering the last verified SVG." };
	}
	return { svg: "", notes: `FAILED: iteration limit (${maxIterations}) reached without a verified SVG.` };
}

const SVG_EDIT = { write: "write_svg", render: "render_svg", noun: "SVG" };
const MANIM_EDIT = { write: "write_manim", render: "render_manim", noun: "scene" };

function finish(svg: string | null, finalText: string): VisualResult {
	if (!svg) {
		return {
			svg: "",
			notes: `FAILED: the maker never wrote an SVG.${finalText ? ` (${finalText.slice(0, 300)})` : ""}`,
		};
	}
	return { svg, notes: finalText || undefined };
}
