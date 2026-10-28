/**
 * ANIMATIONS (M13): the Manim-backed sub-agents with a FAKE renderer and a
 * scripted model — no Docker, no network:
 *
 *   1. the animation maker: preview → look → final render, the unlooked-
 *      finish gate, the length limit, a failed final render, a renderer
 *      that isn't ready, bad tool calls, the iteration limit
 *   2. Manim stills in the visual maker: offered only when the renderer is
 *      ready and the job has a chat to save into; the last medium wins
 *   3. applyExactEdit (shared by every maker): `$` patterns stay literal
 *   4. the animation tool: offered only while the renderer is ready, one
 *      job per tool call, the teacher registry and the Settings toggle
 *   5. the job runner: animation and visual jobs end to end, and the
 *      honest failure when the server has no renderer
 *   6. the cards: the video player and its failure/offline states, the
 *      inverted steer, the held delivery, Manim stills in the figure card,
 *      pngFigureSvg
 *
 * Runs under an isolated LH_DATA_DIR (jobs and chats are written to disk):
 * the seam is set before any config-loading import, so the store, runner,
 * maker, and tool modules are imported dynamically.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React; // tsx classic-JSX shim (see render-cards.test.tsx)

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { Value } from "typebox/value";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import { renderToStaticMarkup } from "react-dom/server";
import { AnimationCard, AnimationOutputCard } from "../components/artifacts/animation-card.tsx";
import { pngFigureSvg, VisualOutputCard } from "../components/artifacts/visual-card.tsx";
import { SubagentSteerCard } from "../components/artifacts/steer-card.tsx";
import { artifactRenderers } from "../components/artifacts/index.ts";
import { slugFilename } from "../components/artifacts/download.ts";
import { ChatActionsContext } from "../components/chat.tsx";
import { HeldResultsContext, JobsContext, heldResultJobIds } from "../components/jobs-context.ts";
import { applyExactEdit } from "../src/agent/subagents/maker-kit.ts";
import {
	buildSubagentSteer,
	setSteerUiInverted,
	type AnimationResult,
	type JobRecord,
	type SteerMessage,
	type VisualResult,
} from "../src/core/contracts.ts";
import { MANIM_IMAGE, mediaUrl, type ManimRenderer, type ManimRenderRequest, type ManimStatus } from "../src/core/manim.ts";
import { newAnswerResult, newUserMessage, type LhMessage } from "../src/core/native-messages.ts";
import { dismissedAnswer } from "../src/core/question-core.ts";
import { projectView } from "../src/core/view.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { HeadlessApi } from "../src/agent/subagents/headless.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-animations-"));
process.env.LH_DATA_DIR = path.join(TMP, "data");
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
const { PATHS } = await import("../config.ts");
if (!PATHS.media.startsWith(TMP)) throw new Error(`not hermetic: ${PATHS.media}`);
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { animationModelOverride, createJobRunner, visualModelOverride } = await import("../src/agent/subagents/runner.ts");
const { headlessOverride } = await import("../src/agent/subagents/headless.ts");
const { runAnimationMaker } = await import("../src/agent/subagents/animation-maker.ts");
const { runVisualMaker } = await import("../src/agent/subagents/visual-maker.ts");
const { animationInputSchema, jobTools } = await import("../src/agent/tools/jobs.ts");
const { createTeacherTools } = await import("../src/agent/tools.ts");

after(() => {
	animationModelOverride.current = undefined;
	visualModelOverride.current = undefined;
	headlessOverride.current = undefined;
	fs.rmSync(TMP, { recursive: true, force: true });
});

// ─── fakes ───────────────────────────────────────────────────────────────────

interface ScriptedTurn {
	toolCalls?: Array<{ id: string; name: string; input: unknown }>;
	text?: string;
}

/** A scripted engine (faux provider): one queued response per model call,
 *  in order — plus every context the maker sent, as JSON, to assert on. */
function scriptedModel(turns: ScriptedTurn[]): { engine: PiEngine; contexts: string[] } {
	const steps: FauxResponseStep[] = turns.map((turn) =>
		turn.toolCalls
			? fauxAssistantMessage(
					turn.toolCalls.map((c) => fauxToolCall(c.name, c.input as ToolCall["arguments"], { id: c.id })),
					{ stopReason: "toolUse" },
				)
			: fauxAssistantMessage(turn.text ?? ""),
	);
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	const contexts: string[] = [];
	const engine: PiEngine = {
		model: faux.getModel(),
		streamFn: (model, context, options) => {
			contexts.push(JSON.stringify(context));
			return faux.streamSimple(model, context, options);
		},
	};
	return { engine, contexts };
}

/** Whether the model was shown `text` in a context (contexts are JSON). */
function shown(context: string | undefined, text: string): boolean {
	return (context ?? "").includes(JSON.stringify(text).slice(1, -1));
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const fakePng = (tag: string) => Buffer.concat([Buffer.from(PNG_MAGIC), Buffer.from(tag)]).toString("base64");
/** The preview's contact sheet and a still, told apart by their bytes. */
const SHEET_B64 = fakePng("SHEET");
const STILL_B64 = fakePng("STILL");

const READY: ManimStatus = { state: "ready", reason: "Ready.", image: MANIM_IMAGE };
const STOPPED: ManimStatus = { state: "docker-stopped", reason: "Docker is installed but not running.", image: MANIM_IMAGE };

/** A fake renderer that records every render. Previews last
 *  `previewSeconds` in turn (then 20 s); the first `failFinal` final
 *  renders fail. */
function fakeManim(opts: { ready?: boolean; previewSeconds?: number[]; failFinal?: number } = {}) {
	const ready = opts.ready ?? true;
	const previewSeconds = [...(opts.previewSeconds ?? [])];
	let failFinal = opts.failFinal ?? 0;
	const renders: ManimRenderRequest[] = [];
	const renderer: ManimRenderer = {
		ready: () => ready,
		status: async () => (ready ? READY : STOPPED),
		install: async () => (ready ? READY : STOPPED),
		async render(req) {
			renders.push(req);
			if (req.mode === "preview") return { ok: true, pngBase64: SHEET_B64, durationSec: previewSeconds.shift() ?? 20 };
			if (req.mode === "still") {
				return {
					ok: true,
					pngBase64: STILL_B64,
					still: { file: `${req.jobId}.png`, mime: "image/png", width: 1920, height: 1080 },
				};
			}
			if (failFinal > 0) {
				failFinal--;
				return { ok: false, error: "ffmpeg exploded" };
			}
			return {
				ok: true,
				video: { file: `${req.jobId}.mp4`, mime: "video/mp4", width: 1280, height: 720 },
				poster: { file: `${req.jobId}-poster.png`, mime: "image/png" },
				durationSec: 12,
			};
		},
	};
	return { renderer, renders, modes: () => renders.map((r) => r.mode) };
}

function fakeHeadless(): HeadlessApi & { svgRenders: string[] } {
	const svgRenders: string[] = [];
	return {
		svgRenders,
		available: () => true,
		unavailableReason: () => null,
		runDemo: async () => ({ consoleErrors: [], pageErrors: [], failedRequests: [], ok: true }),
		renderSvg: async (svg: string) => {
			svgRenders.push(svg);
			return Buffer.from(PNG_MAGIC);
		},
		renderPdfPages: async () => [],
	};
}

const SCENE = [
	"from manim import *",
	"from cairn_style import *",
	"",
	"class Lesson(Scene):",
	"    def construct(self):",
	"        dot = Dot(color=ACCENT)",
	"        self.play(FadeIn(dot))",
	"        self.wait(1)",
	"",
].join("\n");
const STILL_SCENE = [
	"from manim import *",
	"from cairn_style import *",
	"",
	"class Lesson(Scene):",
	"    def construct(self):",
	"        self.add(NumberLine(x_range=[0, 4, 1]))",
	"",
].join("\n");
const BRIEF = { title: "A dot appears", brief: "One accent dot fades in at the origin, then holds." };
const ANIM_IDS = { chatId: "chat_a", jobId: "job_a1" };
const VIS_IDS = { chatId: "chat_v", jobId: "job_v1" };

const write = (id: string, code = SCENE) => ({ id, name: "write_scene", input: { code } });
const preview = (id: string) => ({ id, name: "render_preview", input: {} });

// ─── 1. the animation maker ──────────────────────────────────────────────────

describe("the animation maker (fake renderer, scripted model)", () => {
	it("previews, looks at the contact sheet, then renders the final video of the scene it looked at", async () => {
		const manim = fakeManim();
		const { engine, contexts } = scriptedModel([
			{ toolCalls: [write("w1")] },
			{ toolCalls: [preview("p1")] },
			{ text: "A dot fades in at the origin and holds." },
		]);
		const activity: string[] = [];
		const result = await runAnimationMaker(BRIEF, { manim: manim.renderer, ...ANIM_IDS, engine, onActivity: (line) => activity.push(line) });
		assert.deepEqual(result, {
			title: "A dot appears",
			video: { file: "job_a1.mp4", mime: "video/mp4", width: 1280, height: 720 },
			poster: { file: "job_a1-poster.png", mime: "image/png" },
			durationSec: 12,
			notes: "A dot fades in at the origin and holds.",
		});
		assert.equal(contexts.length, 3, "write, preview, finish — one model call each");
		assert.deepEqual(manim.modes(), ["preview", "final"]);
		assert.ok(
			manim.renders.every((r) => r.chatId === "chat_a" && r.jobId === "job_a1" && r.code === SCENE),
			"every render is of the written scene, saved under the job",
		);
		assert.ok(!contexts[1]!.includes(SHEET_B64), "nothing to look at before the preview");
		assert.ok(shown(contexts[2], "Rendered — 20.0 s long. The contact sheet follows in the next message."));
		assert.ok(contexts[2]!.includes(SHEET_B64), "the contact sheet goes back to the model");
		assert.ok(activity.includes("rendering the final video"));
	});

	it("finishing before looking previews the final scene and makes the model look first", async () => {
		const manim = fakeManim();
		const { engine, contexts } = scriptedModel([
			{ toolCalls: [write("w1")] },
			{ text: "Done." },
			{ text: "Looked: the dot is centred and holds." },
		]);
		const activity: string[] = [];
		const result = await runAnimationMaker(BRIEF, { manim: manim.renderer, ...ANIM_IDS, engine, onActivity: (line) => activity.push(line) });
		assert.deepEqual(manim.modes(), ["preview", "final"], "nothing is rendered for delivery before the model looks");
		assert.ok(activity.includes("render_preview: previewing the final scene"));
		assert.ok(shown(contexts[2], "You finished without looking at a preview of your final scene."));
		assert.ok(shown(contexts[2], "(20.0 s)"));
		assert.ok(contexts[2]!.includes(SHEET_B64));
		assert.equal(result.video?.file, "job_a1.mp4");
		assert.equal(result.notes, "Looked: the dot is centred and holds.");
	});

	it("an over-long preview is refused unseen; an edit brings it under the limit and the edited scene ships", async () => {
		const manim = fakeManim({ previewSeconds: [75, 20] });
		const { engine, contexts } = scriptedModel([
			{ toolCalls: [write("w1", SCENE.replace("self.wait(1)", "self.wait(70)"))] },
			{ toolCalls: [preview("p1")] },
			{
				toolCalls: [
					{ id: "e1", name: "edit_scene", input: { old_text: "self.wait(70)", new_text: "self.wait(5)" } },
					preview("p2"),
				],
			},
			{ text: "Shortened the hold to fit the limit." },
		]);
		const result = await runAnimationMaker(BRIEF, { manim: manim.renderer, ...ANIM_IDS, engine });
		assert.ok(shown(contexts[2], "RENDER ERROR: the animation runs 75.0 s and the limit is 60 s."));
		assert.ok(!contexts[2]!.includes(SHEET_B64), "an over-long preview is not shown");
		assert.ok(shown(contexts[3], "OK — replaced 1 occurrence. Call render_preview to look at the edited scene."));
		assert.ok(contexts[3]!.includes(SHEET_B64));
		assert.deepEqual(manim.modes(), ["preview", "preview", "final"]);
		const final = manim.renders[2]!.code;
		assert.ok(final.includes("self.wait(5)") && !final.includes("self.wait(70)"), "the final render is the edited scene");
		assert.equal(result.video?.file, "job_a1.mp4");
	});

	it("a failed final render goes back to the model, which must look at a new preview before finishing", async () => {
		const manim = fakeManim({ failFinal: 1 });
		const { engine, contexts } = scriptedModel([
			{ toolCalls: [write("w1")] },
			{ toolCalls: [preview("p1")] },
			{ text: "Done." },
			{ text: "Done again." },
			{ text: "Looked again: still correct." },
		]);
		const result = await runAnimationMaker(BRIEF, { manim: manim.renderer, ...ANIM_IDS, engine });
		assert.deepEqual(manim.modes(), ["preview", "final", "preview", "final"]);
		assert.ok(shown(contexts[3], "The full-quality render failed:\nffmpeg exploded\nFix the scene, preview it again, then finish."));
		assert.ok(shown(contexts[4], "You finished without looking at a preview of your final scene."));
		assert.equal(result.video?.file, "job_a1.mp4");
		assert.equal(result.notes, "Looked again: still correct.");
	});

	it("fails with the renderer's own reason when it isn't ready — no model call, no render", async () => {
		const manim = fakeManim({ ready: false });
		const { engine, contexts } = scriptedModel([]);
		const result = await runAnimationMaker({ title: "  ", brief: "b" }, { manim: manim.renderer, ...ANIM_IDS, engine });
		assert.deepEqual(result, { title: "Animation", video: null, notes: "FAILED: Docker is installed but not running." });
		assert.equal(contexts.length, 0);
		assert.equal(manim.renders.length, 0);
	});

	it("answers bad tool calls with errors the model can act on, and fails if no scene is ever written", async () => {
		const manim = fakeManim();
		const { engine, contexts } = scriptedModel([
			{
				toolCalls: [
					preview("p0"),
					{ id: "w0", name: "write_scene", input: { code: "print('no scene here')" } },
					{ id: "x0", name: "write_svg", input: { svg: "<svg/>" } },
				],
			},
			{ text: "I could not write a scene for this." },
		]);
		const result = await runAnimationMaker(BRIEF, { manim: manim.renderer, ...ANIM_IDS, engine });
		assert.ok(shown(contexts[1], "ERROR: nothing to preview — call write_scene first."));
		assert.ok(shown(contexts[1], "ERROR: expected the complete scene file in the `code` field, defining class Lesson(Scene)."));
		assert.ok(shown(contexts[1], 'ERROR: unknown tool "write_svg". Use write_scene, edit_scene, or render_preview.'));
		assert.deepEqual(result, {
			title: "A dot appears",
			video: null,
			notes: "FAILED: the maker never wrote a scene. (I could not write a scene for this.)",
		});
		assert.equal(manim.renders.length, 0);
	});

	it("at the iteration limit, delivers only an animation the model has looked at", async () => {
		const looked = fakeManim();
		const a = scriptedModel([{ toolCalls: [write("w1")] }, { toolCalls: [preview("p1")] }, { toolCalls: [preview("p2")] }]);
		const delivered = await runAnimationMaker(BRIEF, { manim: looked.renderer, ...ANIM_IDS, engine: a.engine, maxIterations: 3 });
		assert.equal(delivered.video?.file, "job_a1.mp4");
		assert.equal(delivered.notes, "Iteration limit reached — delivering the last previewed animation.");
		assert.deepEqual(looked.modes(), ["preview", "preview", "final"]);

		const refusedFor = async (turns: ScriptedTurn[], maxIterations: number) => {
			const manim = fakeManim();
			const { engine } = scriptedModel(turns);
			const result = await runAnimationMaker(BRIEF, { manim: manim.renderer, ...ANIM_IDS, engine, maxIterations });
			assert.deepEqual(result, {
				title: "A dot appears",
				video: null,
				notes: `FAILED: iteration limit (${maxIterations}) reached without an animation the maker had looked at.`,
			});
			assert.ok(!manim.modes().includes("final"), "an unlooked scene is never rendered for delivery");
		};
		await refusedFor([{ toolCalls: [write("w1")] }], 1);
	});

	it("a preview made on the last turn gets one more call to look at it, and that look's notes ship", async () => {
		const manim = fakeManim();
		const { engine, contexts } = scriptedModel([
			{ toolCalls: [write("w1")] },
			{ toolCalls: [preview("p1")] },
			{ text: "A dot fades in at the origin and holds." },
		]);
		const result = await runAnimationMaker(BRIEF, { manim: manim.renderer, ...ANIM_IDS, engine, maxIterations: 2 });
		assert.equal(contexts.length, 3, "two turns, then one call to look");
		assert.ok(shown(contexts[2], "That was your last turn to change the scene, so this is your final preview."));
		assert.ok(contexts[2]!.includes(SHEET_B64));
		assert.deepEqual(manim.modes(), ["preview", "final"]);
		assert.equal(result.video?.file, "job_a1.mp4");
		assert.equal(result.notes, "A dot fades in at the origin and holds.");

		// Changes asked for in that look are not made: the looked-at scene ships.
		const late = fakeManim();
		const b = scriptedModel([
			{ toolCalls: [write("w1")] },
			{ toolCalls: [preview("p1")] },
			{ toolCalls: [write("w2", SCENE.replace("self.wait(1)", "self.wait(2)"))] },
		]);
		const kept = await runAnimationMaker(BRIEF, { manim: late.renderer, ...ANIM_IDS, engine: b.engine, maxIterations: 2 });
		assert.deepEqual(late.modes(), ["preview", "final"]);
		assert.equal(late.renders[1]!.code, SCENE);
		assert.equal(kept.notes, "Iteration limit reached — delivering the last previewed animation.");
	});

	it("out of turns with changes it never looked at, the newest scene the model looked at ships", async () => {
		const manim = fakeManim();
		const { engine } = scriptedModel([
			{ toolCalls: [write("w1"), preview("p1")] },
			{ toolCalls: [write("w2", SCENE.replace("self.wait(1)", "self.wait(2)"))] },
		]);
		const result = await runAnimationMaker(BRIEF, { manim: manim.renderer, ...ANIM_IDS, engine, maxIterations: 2 });
		assert.deepEqual(manim.modes(), ["preview", "final"]);
		assert.equal(manim.renders[1]!.code, SCENE, "the final render is the looked-at scene, not the unseen rewrite");
		assert.equal(result.video?.file, "job_a1.mp4");
		assert.equal(
			result.notes,
			"Iteration limit reached — delivering the last version the maker looked at; it ran out of turns before looking at its later changes.",
		);
	});

	it("with nothing looked at, the iteration-limit failure ends with the last render error", async () => {
		const traceback = [
			"scene.py line 12, in construct",
			"    label.move_to((0, 1.5))",
			"(raised inside manim/mobject/mobject.py line 2036, in move_to)".repeat(6),
			"ValueError: operands could not be broadcast together with shapes (2,) (3,)",
		].join("\n");
		const renderer: ManimRenderer = { ...fakeManim().renderer, render: async () => ({ ok: false, error: traceback }) };
		const { engine } = scriptedModel([{ toolCalls: [write("w1"), preview("p1")] }]);
		const result = await runAnimationMaker(BRIEF, { manim: renderer, ...ANIM_IDS, engine, maxIterations: 1 });
		assert.equal(result.video, null);
		const notes = result.notes ?? "";
		assert.ok(notes.startsWith("FAILED: iteration limit (1) reached without an animation the maker had looked at. Last render error: …"), notes);
		assert.ok(notes.endsWith("ValueError: operands could not be broadcast together with shapes (2,) (3,)"), "the exception survives");
	});
});

// ─── 2. Manim stills in the visual maker ─────────────────────────────────────

describe("Manim stills in the visual maker", () => {
	const writeManim = { id: "m1", name: "write_manim", input: { code: STILL_SCENE } };
	const renderManim = { id: "r1", name: "render_manim", input: {} };

	it("with a ready renderer and a job, renders the still, looks at it, and delivers the saved PNG", async () => {
		const manim = fakeManim();
		const headless = fakeHeadless();
		const { engine, contexts } = scriptedModel([{ toolCalls: [writeManim, renderManim] }, { text: "A number line from 0 to 4." }]);
		const result = await runVisualMaker({ brief: "a number line" }, { engine, headless, manim: manim.renderer, ...VIS_IDS });
		assert.equal(result.svg, "");
		assert.deepEqual(result.png, { file: "job_v1.png", mime: "image/png", width: 1920, height: 1080 });
		assert.equal(result.notes, "A number line from 0 to 4.");
		assert.deepEqual(
			manim.renders.map((r) => [r.mode, r.chatId, r.jobId]),
			[["still", "chat_v", "job_v1"]],
		);
		assert.equal(headless.svgRenders.length, 0);
		assert.ok(contexts[0]!.includes("write_manim"), "the Manim tools are offered");
		assert.ok(shown(contexts[1], "Rendered — the final frame follows in the next message. Look at it."));
		assert.ok(contexts[1]!.includes(STILL_B64), "the model looks at the still");
	});

	it("finishing before looking renders the final scene's still and makes the model look", async () => {
		const manim = fakeManim();
		const { engine, contexts } = scriptedModel([
			{ toolCalls: [writeManim] },
			{ text: "Done." },
			{ text: "Looked: the ticks are evenly spaced." },
		]);
		const result = await runVisualMaker({ brief: "a number line" }, { engine, headless: fakeHeadless(), manim: manim.renderer, ...VIS_IDS });
		assert.deepEqual(manim.modes(), ["still"]);
		assert.ok(shown(contexts[2], "You finished without looking at a render of your final scene."));
		assert.ok(contexts[2]!.includes(STILL_B64));
		assert.equal(result.png?.file, "job_v1.png");
		assert.equal(result.notes, "Looked: the ticks are evenly spaced.");
	});

	it("at the iteration limit, delivers only a still the model has looked at", async () => {
		const run = (turns: ScriptedTurn[], maxIterations: number) =>
			runVisualMaker(
				{ brief: "a number line" },
				{ engine: scriptedModel(turns).engine, headless: fakeHeadless(), manim: fakeManim().renderer, ...VIS_IDS, maxIterations },
			);
		const delivered = await run([{ toolCalls: [writeManim, renderManim] }, { toolCalls: [renderManim] }], 2);
		assert.equal(delivered.png?.file, "job_v1.png");
		assert.equal(delivered.notes, "Iteration limit reached — delivering the last verified still.");
		// The still rendered on the last turn reaches no model call.
		assert.deepEqual(await run([{ toolCalls: [writeManim, renderManim] }], 1), {
			svg: "",
			notes: "FAILED: iteration limit (1) reached without a verified figure.",
		});
	});

	it("delivers the medium written last: an SVG drawn after a still ships as the SVG", async () => {
		const manim = fakeManim();
		const headless = fakeHeadless();
		const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><line x1="0" y1="20" x2="100" y2="20"/></svg>';
		const { engine } = scriptedModel([
			{ toolCalls: [writeManim, renderManim] },
			{ toolCalls: [{ id: "s1", name: "write_svg", input: { svg } }, { id: "r2", name: "render_svg", input: {} }] },
			{ text: "Switched to SVG for crisper ticks." },
		]);
		const result = await runVisualMaker({ brief: "a number line" }, { engine, headless, manim: manim.renderer, ...VIS_IDS });
		assert.equal(result.svg, svg);
		assert.equal(result.png, undefined);
		assert.deepEqual(headless.svgRenders, [svg]);
	});

	it("offers no Manim tools unless the renderer is ready AND the job has a chat to save into", async () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>';
		const cases: Array<{ label: string; manim: ReturnType<typeof fakeManim>; ids: Partial<typeof VIS_IDS> }> = [
			{ label: "renderer not ready", manim: fakeManim({ ready: false }), ids: VIS_IDS },
			{ label: "no chat or job", manim: fakeManim(), ids: {} },
		];
		for (const c of cases) {
			const { engine, contexts } = scriptedModel([
				{ toolCalls: [writeManim] },
				{ toolCalls: [{ id: "s1", name: "write_svg", input: { svg } }, { id: "r2", name: "render_svg", input: {} }] },
				{ text: "Drawn as SVG." },
			]);
			const result = await runVisualMaker({ brief: "b" }, { engine, headless: fakeHeadless(), manim: c.manim.renderer, ...c.ids });
			assert.ok(!contexts[0]!.includes("write_manim"), `${c.label}: no Manim tools or instructions`);
			assert.ok(shown(contexts[1], 'ERROR: unknown tool "write_manim". Use write_svg, edit_svg, or render_svg.'), c.label);
			assert.equal(result.svg, svg, c.label);
			assert.equal(c.manim.renders.length, 0, c.label);
		}
	});
});

// ─── 3. applyExactEdit ───────────────────────────────────────────────────────

describe("applyExactEdit (shared by every maker)", () => {
	const NAMES = { write: "write_scene", render: "render_preview", noun: "scene" };

	it("replaces exactly one occurrence, and `$` patterns in the new text stay literal", () => {
		const edit = applyExactEdit("self.play(Write(label))\n", { old_text: "label", new_text: "MathTex(r'$$x$$ costs $&5')" }, NAMES);
		assert.deepEqual(edit, {
			next: "self.play(Write(MathTex(r'$$x$$ costs $&5')))\n",
			reply: "OK — replaced 1 occurrence. Call render_preview to look at the edited scene.",
		});
	});

	it("refuses with a reason the model can act on", () => {
		assert.deepEqual(applyExactEdit(null, { old_text: "a", new_text: "b" }, NAMES), {
			next: null,
			reply: "ERROR: nothing to edit — call write_scene first.",
		});
		const twice = applyExactEdit("x = 1\nx = 1\n", { old_text: "x = 1", new_text: "x = 2" }, NAMES);
		assert.equal(twice.next, null);
		assert.match(twice.reply, /^ERROR: old_text appears 2 times — it must match EXACTLY ONCE\./);
		const missing = applyExactEdit("a = 1\nb = 2\n", { old_text: "c = 3", new_text: "c = 4" }, NAMES);
		assert.equal(missing.next, null);
		assert.match(missing.reply, /^ERROR: old_text not found\. Closest line for reference:\n/);
		for (const args of [{ old_text: "", new_text: "y" }, { old_text: "a" }, undefined]) {
			assert.deepEqual(applyExactEdit("a = 1\n", args, NAMES), {
				next: null,
				reply: "ERROR: expected old_text (non-empty) and new_text strings.",
			});
		}
	});
});

// ─── 4. the animation tool ───────────────────────────────────────────────────

describe("the animation tool (offered only while the renderer is ready)", () => {
	it("joins the job tools only when animationAvailable() says so; the schema needs a title and a brief", () => {
		const base = { chatId: "chat_r", jobStore, spawn: () => {} };
		assert.deepEqual(Object.keys(jobTools(base)).sort(), ["demo", "pdf", "research", "visual"]);
		assert.ok(!("animation" in jobTools({ ...base, animationAvailable: () => false })));
		assert.deepEqual(Object.keys(jobTools({ ...base, animationAvailable: () => true })).sort(), [
			"animation",
			"demo",
			"pdf",
			"research",
			"visual",
		]);
		assert.equal(Value.Check(animationInputSchema, { title: "T", brief: "b" }), true);
		assert.equal(Value.Check(animationInputSchema, { brief: "b" }), false, "an animation needs a title");
		assert.equal(Value.Check(animationInputSchema, { title: "T" }), false, "and a brief");
	});

	it("dispatch creates one animation job per tool call, saves its input, and acks fire-and-forget", async () => {
		const chat = chatStore.createChat("Animation dispatch");
		const spawned: Array<{ job: JobRecord; input: unknown }> = [];
		const tools = jobTools({
			chatId: chat.id,
			jobStore,
			spawn: (job, input) => {
				spawned.push({ job, input });
			},
			animationAvailable: () => true,
		});
		const input = { title: "Resize", brief: "Buckets double; entries rehash one by one." };
		const first = await tools.animation!.execute("call_anim_1", input);
		const again = await tools.animation!.execute("call_anim_1", input);
		assert.equal(spawned.length, 1, "a replay of the same call spawns nothing");
		const job = spawned[0]!.job;
		assert.equal(job.kind, "animation");
		assert.deepEqual(spawned[0]!.input, input);
		assert.deepEqual(jobStore.getJob(job.id)?.input, input, "the input is saved for crash recovery");
		for (const out of [first, again]) {
			assert.ok(String(out.details).startsWith(`Dispatched (job ${job.id}). `), String(out.details));
			assert.match(String(out.details), /plays in the lesson; narrate it then\.$/);
		}
	});

	it("the teacher registry passes the gate through, and the Settings toggle can still drop it", () => {
		const ctx = { chatId: "chat_r", chatStore, jobStore, spawn: () => {} };
		assert.ok(!("animation" in createTeacherTools(ctx)), "no renderer, no tool");
		assert.ok("animation" in createTeacherTools({ ...ctx, animationAvailable: () => true }));
		assert.ok(
			!("animation" in createTeacherTools({ ...ctx, animationAvailable: () => true }, { animation: false })),
			"turned off in Settings",
		);
	});

	it("its tool part renders the dispatch card: Animation agent, settling quietly", () => {
		assert.equal(artifactRenderers.animation, AnimationCard);
		const part = {
			type: "tool-animation",
			state: "output-available",
			toolCallId: "call_anim_9",
			input: { title: "T", brief: "b" },
			output: "Dispatched (job j9).",
		};
		const now = new Date().toISOString();
		const done = {
			id: "j9",
			kind: "animation",
			chatId: "c",
			toolCallId: "call_anim_9",
			status: "done",
			activity: "delivered",
			createdAt: now,
			updatedAt: now,
		} as JobRecord;
		const html = renderToStaticMarkup(
			<JobsContext.Provider value={[done]}>
				<AnimationCard part={part as never} />
			</JobsContext.Provider>,
		);
		assert.match(html, /Animation agent/);
		assert.match(html, /finished/);
		assert.equal(renderToStaticMarkup(<AnimationCard part={{ ...part, state: "input-available" } as never} />), "");
	});
});

// ─── 5. jobs through the runner ──────────────────────────────────────────────

describe("animation and visual jobs through the runner", () => {
	function testRunner(manim?: ManimRenderer) {
		const steers: SteerMessage[] = [];
		const runner = createJobRunner({
			chatStore,
			jobStore,
			deliver: async (steer) => {
				steers.push(steer);
			},
			...(manim ? { manim } : {}),
		});
		return { steers, runner };
	}

	it("an animation job renders under its chat and job, then steers the lesson to play it", async () => {
		const chat = chatStore.createChat("Animation job");
		const job = jobStore.createJob({ kind: "animation", chatId: chat.id, toolCallId: "call_aj1", input: BRIEF });
		const manim = fakeManim();
		const { engine } = scriptedModel([
			{ toolCalls: [write("w1")] },
			{ toolCalls: [preview("p1")] },
			{ text: "A dot fades in and holds." },
		]);
		animationModelOverride.current = engine;
		try {
			const { steers, runner } = testRunner(manim.renderer);
			await runner.runJob(job.id);
			const record = jobStore.getJob(job.id)!;
			assert.equal(record.status, "done");
			assert.equal(record.activity, "finished");
			assert.equal((record.result as AnimationResult).video?.file, `${job.id}.mp4`);
			assert.deepEqual(
				manim.renders.map((r) => [r.mode, r.chatId, r.jobId]),
				[
					["preview", chat.id, job.id],
					["final", chat.id, job.id],
				],
			);
			assert.equal(steers.length, 1);
			assert.equal(steers[0]!.id, `steer_${job.id}`);
			assert.match(
				String(steers[0]!.content),
				/^The animation "A dot appears" is rendered \(12 s\) and plays in the lesson\. Maker notes: A dot fades in and holds\./,
			);
		} finally {
			animationModelOverride.current = undefined;
		}
	});

	it("with no renderer on the server, the job fails honestly and the teacher hears why", async () => {
		const chat = chatStore.createChat("No renderer");
		const job = jobStore.createJob({ kind: "animation", chatId: chat.id, toolCallId: "call_aj2", input: BRIEF });
		const { engine, contexts } = scriptedModel([]);
		animationModelOverride.current = engine;
		try {
			const { steers, runner } = testRunner();
			await runner.runJob(job.id);
			const record = jobStore.getJob(job.id)!;
			assert.equal(record.status, "error");
			assert.equal(record.error, "animations aren't set up on this server");
			assert.equal(contexts.length, 0, "no model call is spent");
			assert.match(
				String(steers[0]!.content),
				/^The animation "A dot appears" could not be made: FAILED: animations aren't set up on this server\. Fall back to a figure/,
			);
		} finally {
			animationModelOverride.current = undefined;
		}
	});

	it("a visual job may draw a Manim still, saved under its chat and job", async () => {
		const chat = chatStore.createChat("Visual still");
		const job = jobStore.createJob({ kind: "visual", chatId: chat.id, toolCallId: "call_vj1", input: { brief: "a number line" } });
		const manim = fakeManim();
		const { engine } = scriptedModel([
			{
				toolCalls: [
					{ id: "m1", name: "write_manim", input: { code: STILL_SCENE } },
					{ id: "r1", name: "render_manim", input: {} },
				],
			},
			{ text: "A number line from 0 to 4." },
		]);
		visualModelOverride.current = engine;
		headlessOverride.current = fakeHeadless();
		try {
			const { steers, runner } = testRunner(manim.renderer);
			await runner.runJob(job.id);
			const record = jobStore.getJob(job.id)!;
			assert.equal(record.status, "done");
			assert.equal((record.result as VisualResult).png?.file, `${job.id}.png`);
			assert.deepEqual(
				manim.renders.map((r) => [r.mode, r.chatId, r.jobId]),
				[["still", chat.id, job.id]],
			);
			assert.match(String(steers[0]!.content), /^The figure is drawn, verified by inspection, and rendered in the lesson\./);
		} finally {
			visualModelOverride.current = undefined;
			headlessOverride.current = undefined;
		}
	});
});

// ─── 6. the cards ────────────────────────────────────────────────────────────

describe("animation and still cards", () => {
	const ACTIONS = { chatId: "chat_1", syncFromServer: async () => {}, sendText: () => {}, openSetup: () => {} };
	const RESULT: AnimationResult = {
		title: "How a hash table resizes",
		video: { file: "job_c1.mp4", mime: "video/mp4", width: 1280, height: 720 },
		poster: { file: "job_c1-poster.png", mime: "image/png" },
		durationSec: 12.4,
		notes: "Maker notes the learner never sees.",
	};
	const inChat = (node: React.ReactNode) =>
		renderToStaticMarkup(<ChatActionsContext.Provider value={ACTIONS}>{node}</ChatActionsContext.Provider>);

	it("plays the MP4 from the chat's media route, with its poster, length, and download", () => {
		const html = inChat(<AnimationOutputCard output={RESULT} />);
		assert.match(html, /data-testid="animation-card"/);
		assert.ok(html.includes(`src="${mediaUrl("chat_1", "job_c1.mp4")}"`));
		assert.ok(html.includes(`poster="${mediaUrl("chat_1", "job_c1-poster.png")}"`));
		assert.match(html, /<video[^>]*\bcontrols/);
		assert.match(html, /<video[^>]*playsinline/i);
		assert.match(html, /<video[^>]*preload="metadata"/);
		assert.match(html, /· 12 s/);
		assert.ok(html.includes(`download="${slugFilename(RESULT.title)}.mp4"`));
		assert.ok(!html.includes("hue-rotate"), "not inverted by default");
		assert.ok(!html.includes("Maker notes"), "the maker's notes are for the teacher");
	});

	it("an inverted steer plays the video through the invert filter", () => {
		const steer = buildSubagentSteer({ id: "job_c1", kind: "animation", toolCallId: "call_c1" }, RESULT);
		const [inverted] = setSteerUiInverted([steer], steer.id, true);
		const html = inChat(<SubagentSteerCard message={projectView([inverted!])[0] as never} />);
		assert.match(html, /data-testid="animation-card"/);
		assert.match(html, /invert\(1\) hue-rotate\(180deg\)/);
	});

	it("failed, offline, and unreadable results each say so plainly", () => {
		const failed = inChat(<AnimationOutputCard output={{ title: "T", video: null, notes: "FAILED: Docker is installed but not running." }} />);
		assert.match(failed, /data-testid="animation-card-failed"/);
		assert.match(failed, /FAILED: Docker is installed but not running\./);
		assert.ok(!failed.includes("<video"));
		assert.match(inChat(<AnimationOutputCard output={{ title: "T", video: null }} />), /The animation could not be made\./);
		const offline = renderToStaticMarkup(<AnimationOutputCard output={RESULT} />);
		assert.match(offline, /data-testid="animation-card-offline"/);
		assert.match(offline, /Animation ready: How a hash table resizes\. Open the session to play it\./);
		assert.ok(!offline.includes("<video"), "no player without a chat to serve the file");
		assert.match(renderToStaticMarkup(<AnimationOutputCard output="oops" />), /the result could not be displayed/);
	});

	describe("a result the learner holds (an unanswered question or a dismissal)", () => {
		const now = new Date().toISOString();
		const job = (over: Partial<JobRecord> = {}): JobRecord => ({
			id: "job_h1",
			kind: "animation",
			chatId: "chat_1",
			toolCallId: "call_anim",
			status: "done",
			activity: "delivered",
			createdAt: now,
			updatedAt: now,
			result: RESULT,
			delivery: { kind: "result", status: "pending" },
			...over,
		});
		const asking = {
			id: "a1",
			role: "assistant",
			content: [
				{ type: "toolCall", id: "call_anim", name: "animation", arguments: {} },
				{ type: "toolCall", id: "call_q", name: "quiz", arguments: {} },
			],
			timestamp: 0,
		} as unknown as LhMessage;
		const ack = {
			id: "r_anim",
			role: "toolResult",
			toolCallId: "call_anim",
			toolName: "animation",
			content: [{ type: "text", text: "Dispatched (job job_h1)." }],
			isError: false,
			timestamp: 0,
		} as unknown as LhMessage;
		const quizOpen: LhMessage[] = [{ ...newUserMessage("topic"), id: "u1" }, asking, ack];
		const answered: LhMessage[] = [...quizOpen, { ...newAnswerResult("call_q", "quiz", { ok: true }), id: "r_q" }];
		const dismissed: LhMessage[] = [
			...quizOpen,
			{ ...newAnswerResult("call_q", "quiz", dismissedAnswer("quiz", "Which token comes next?")), id: "d_q" },
		];
		const steer = buildSubagentSteer({ id: "job_h1", kind: "animation", toolCallId: "call_anim" }, RESULT);

		it("holds a finished, undelivered result only behind a question or a dismissal", () => {
			assert.deepEqual([...heldResultJobIds([job()], quizOpen)], ["job_h1"], "the unanswered check holds the steer");
			assert.deepEqual([...heldResultJobIds([job()], dismissed)], ["job_h1"], "so does a dismissal tail");
			assert.equal(heldResultJobIds([job()], answered).size, 0, "nothing holds it: the steer is a moment away");
			assert.equal(heldResultJobIds([job()], [...quizOpen, steer as unknown as LhMessage]).size, 0, "the steer landed");
			for (const over of [
				{ delivery: { kind: "result", status: "delivered" } },
				{ delivery: undefined },
				{ status: "running", result: undefined },
				{ status: "error", delivery: { kind: "abort", status: "pending" } },
			] as Partial<JobRecord>[]) {
				assert.equal(heldResultJobIds([job(over)], quizOpen).size, 0, JSON.stringify(over));
			}
		});

		it("the dispatch card plays a held video under its one-liner, and stays quiet otherwise", () => {
			const part = {
				type: "tool-animation",
				state: "output-available",
				toolCallId: "call_anim",
				input: { title: "T", brief: "b" },
				output: "Dispatched (job job_h1).",
			};
			const card = (held: ReadonlySet<string>) =>
				inChat(
					<JobsContext.Provider value={[job()]}>
						<HeldResultsContext.Provider value={held}>
							<AnimationCard part={part as never} />
						</HeldResultsContext.Provider>
					</JobsContext.Provider>,
				);
			const held = card(new Set(["job_h1"]));
			assert.match(held, /data-testid="dispatch-held"/);
			assert.match(held, /Animation agent.*finished/s);
			assert.ok(held.includes(`src="${mediaUrl("chat_1", "job_c1.mp4")}"`));
			const quiet = card(new Set());
			assert.match(quiet, /data-testid="dispatch-settled"/);
			assert.ok(!quiet.includes("<video"), "the steer card owns the artifact");
		});
	});

	it("a Manim still shows in the figure card from the media route, with a PNG download", () => {
		const still: VisualResult = { svg: "", png: { file: "job_v1.png", mime: "image/png", width: 1920, height: 1080 } };
		const html = inChat(<VisualOutputCard output={still} />);
		assert.match(html, /data-testid="visual-png"/);
		assert.ok(html.includes(`src="${mediaUrl("chat_1", "job_v1.png")}"`));
		assert.match(html, /download="figure\.png"/);
		assert.ok(!html.includes("visual-card-failed"), "an empty svg beside a still is not a failure");
		const offline = renderToStaticMarkup(<VisualOutputCard output={still} />);
		assert.match(offline, /data-testid="visual-png-offline"/);
		assert.match(offline, /Figure ready\. Open the session to view it\./);
	});

	it("pngFigureSvg wraps only a base64 PNG data URL, at whole-pixel size", () => {
		const url = `data:image/png;base64,${STILL_B64}`;
		assert.equal(
			pngFigureSvg(url, 1919.6, 1080),
			`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><image href="${url}" width="1920" height="1080"/></svg>`,
		);
		assert.match(pngFigureSvg(url, 0, Number.NaN) ?? "", /width="1" height="1" viewBox="0 0 1 1"/);
		for (const bad of [
			"data:image/svg+xml;base64,PHN2Zz4=",
			`${url}"/><script>alert(1)</script>`,
			"https://example.com/still.png",
		]) {
			assert.equal(pngFigureSvg(bad, 10, 10), null, bad);
		}
	});
});
