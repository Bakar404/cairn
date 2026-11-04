/**
 * motion.spec.ts — reduced motion (accessibility mode, M27), against the
 * same build and fixtures as the axe checks.
 *
 * - Motion "System" follows the OS: the reduced-motion project loads with
 *   nothing looping, the default project with the animations on.
 * - Reduced stops every looping animation and the entrances, and Full runs
 *   them even when the OS asks for less motion. The boot script applies the
 *   saved choice on the next load, before the settings arrive.
 * - The knowledge graph opens at rest with motion reduced: its layout
 *   settles before it's drawn, where Full draws the settle frame by frame.
 *
 * The app's loops only run while something is busy (a reply streaming, a
 * tool running, a diagram loading), so the spec plants a probe for each
 * animation the stylesheet can start and reads what the browser runs.
 */
import type { Page } from "@playwright/test";
import { expect, homeReady, hydrated, resetAccessibility, test } from "./app.ts";

type Motion = "reduced" | "full";
type MotionState = { probes: Record<string, string>; loops: string[] };

/** A class the app's markup uses and the keyframes it starts with motion
 *  on: the loops (BrailleSpinner's frames, the app's spinners and pulses
 *  behind motion-safe:, and the bare animate-spin of streamdown's loading
 *  spinners), then the one-shot entrances (app/globals.css). */
const PROBES = [
	{ cls: "braille-frame", keyframes: "braille-frame", loops: true },
	{ cls: "motion-safe:animate-spin", keyframes: "spin", loops: true },
	{ cls: "motion-safe:animate-pulse", keyframes: "pulse", loops: true },
	{ cls: "animate-spin", keyframes: "spin", loops: true },
	{ cls: "dock-variant", keyframes: "dock-variant-in", loops: false },
	{ cls: "settings-dialog-pop", keyframes: "settings-pop", loops: false },
	{ cls: "graph-chrome-fade-in", keyframes: "chrome-fade-in", loops: false },
	{ cls: "lh-card-enter", keyframes: "lh-card-enter", loops: false },
];
/** The animated settle is one frame per simulation tick: alpha falls from 1
 *  to the rest threshold in 104 ticks (components/graph-canvas.ts). */
const SETTLE_FRAMES = 104;
/** A load at rest draws a handful of frames (data, settings, size), each
 *  change coalesced into the next one. */
const REST_FRAMES = 10;

test("Reduced stops every loop, Full runs them over the OS, and the next load applies the choice before settings arrive", async ({ page }, testInfo) => {
	const os: Motion = testInfo.project.name === "reduced-motion" ? "reduced" : "full";
	const other: Motion = os === "reduced" ? "full" : "reduced";
	await openHome(page);
	const html = page.locator("html");
	await expect(html, "Motion starts on System, which follows the OS").toHaveAttribute("data-motion", os);
	await plantProbes(page);
	expectMotion(await motionState(page), os);
	try {
		// The OS's own value, then the other: the last choice is one the OS
		// wouldn't make, so after the reload only the saved setting explains it.
		await test.step(os, async () => {
			await chooseMotion(page, os, `Follows your system (${os} now)`);
			expectMotion(await motionState(page), os);
		});
		await test.step(other, async () => {
			await chooseMotion(page, other);
			expectMotion(await motionState(page), other);
		});

		// With the settings request failing, the provider never applies:
		// only the boot script can have set it.
		await page.route("**/api/settings", (route) => route.abort());
		await page.reload({ waitUntil: "domcontentloaded" });
		expect(await html.getAttribute("data-motion"), "before the settings load").toBe(other);
	} finally {
		await resetAccessibility(page);
	}
});

test("the knowledge graph opens at rest with motion reduced, and draws its settle with motion on", async ({ page }) => {
	test.slow();
	await countGraphFrames(page);
	await openHome(page);
	try {
		await chooseMotion(page, "full");
		const full = await framesToRest(page);
		expect(full, "with motion on, the load's settle draws frame by frame").toBeGreaterThanOrEqual(SETTLE_FRAMES);

		await chooseMotion(page, "reduced");
		const reduced = await framesToRest(page);
		expect(reduced, "with motion reduced, the graph is drawn at rest").toBeLessThanOrEqual(REST_FRAMES);
	} finally {
		await resetAccessibility(page);
	}
});

async function openHome(page: Page) {
	await page.goto("/");
	await hydrated(page, "dark");
	await homeReady(page);
}

/** Picks Motion in Settings → Accessibility, as a user does, and waits
 *  until it's saved, applied and cached for the boot script. `hint` is what
 *  the row says before the change. */
async function chooseMotion(page: Page, motion: Motion, hint?: string) {
	await page.getByTestId("settings-entry").click();
	const dialog = page.getByTestId("settings-dialog");
	await expect(dialog.getByText("Loading settings…")).toHaveCount(0);
	await dialog.getByTestId("settings-nav-accessibility").click();
	const row = dialog.getByTestId("row-motion");
	if (hint) await expect(row).toContainText(hint);
	const saved = page.waitForResponse(
		(r) => r.url().endsWith("/api/settings/accessibility") && r.request().method() === "PUT",
	);
	await row.getByTestId("select-motion").selectOption(motion);
	expect((await saved).ok(), "PUT /api/settings/accessibility").toBe(true);
	await expect(page.locator("html")).toHaveAttribute("data-motion", motion);
	await page.waitForFunction(
		(motion) => (JSON.parse(localStorage.getItem("cairn-a11y") ?? "{}") as { motion?: string }).motion === motion,
		motion,
	);
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
}

/** One probe per class, out of the way of the pointer. */
async function plantProbes(page: Page) {
	await page.evaluate(
		(classes) => {
			const box = document.createElement("div");
			box.id = "motion-probes";
			box.setAttribute("aria-hidden", "true");
			box.style.cssText = "position: fixed; left: 0; bottom: 0; pointer-events: none";
			for (const cls of classes) {
				const probe = document.createElement("span");
				probe.className = cls;
				probe.dataset.probe = cls;
				probe.textContent = "⠋";
				box.append(probe);
			}
			document.body.append(box);
		},
		PROBES.map((p) => p.cls),
	);
}

/** Each probe's computed animation-name, and every running animation on
 *  the page that repeats forever. */
function motionState(page: Page): Promise<MotionState> {
	return page.evaluate(() => {
		const probes: Record<string, string> = {};
		for (const el of document.querySelectorAll<HTMLElement>("#motion-probes [data-probe]")) {
			probes[el.dataset.probe ?? ""] = getComputedStyle(el).animationName;
		}
		const loops = document
			.getAnimations()
			.filter((a) => a.playState === "running" && a.effect?.getComputedTiming().iterations === Infinity)
			.map((a) => {
				const target = a.effect instanceof KeyframeEffect ? a.effect.target : null;
				const name = a instanceof CSSAnimation ? a.animationName : "script";
				return `${name} on ${target?.getAttribute("data-probe") ?? target?.outerHTML.slice(0, 120) ?? "?"}`;
			});
		return { probes, loops };
	});
}

function expectMotion(state: MotionState, motion: Motion) {
	if (motion === "full") {
		expect(state.probes, "every probe animates").toEqual(Object.fromEntries(PROBES.map((p) => [p.cls, p.keyframes])));
		const loops = PROBES.filter((p) => p.loops).map((p) => `${p.keyframes} on ${p.cls}`);
		expect(state.loops, "the loops run").toEqual(expect.arrayContaining(loops));
	} else {
		expect(state.probes, "no probe animates").toEqual(Object.fromEntries(PROBES.map((p) => [p.cls, "none"])));
		expect(state.loops, "nothing on the page loops").toEqual([]);
	}
}

/** Counts the frames the graph draws: GraphCanvas.draw() clears its canvas
 *  (the page's one role="img" canvas) once per frame. Runs in every
 *  document the page loads. */
async function countGraphFrames(page: Page) {
	await page.addInitScript(() => {
		const w = window as Window & { graphFrames?: number };
		w.graphFrames = 0;
		const clear = CanvasRenderingContext2D.prototype.clearRect;
		CanvasRenderingContext2D.prototype.clearRect = function (x, y, width, height) {
			if (this.canvas.getAttribute("role") === "img") w.graphFrames = (w.graphFrames ?? 0) + 1;
			clear.call(this, x, y, width, height);
		};
	});
}

/** Reloads home and counts the graph's frames until a second passes
 *  without one. */
async function framesToRest(page: Page): Promise<number> {
	await page.reload();
	await homeReady(page);
	await expect(page.getByRole("img", { name: /^Knowledge graph:/ })).toBeVisible();
	let last = -1;
	await expect
		.poll(
			async () => {
				const now = await page.evaluate(() => (window as Window & { graphFrames?: number }).graphFrames ?? 0);
				const resting = now > 0 && now === last;
				last = now;
				return resting;
			},
			{ message: "the graph stops drawing", intervals: [1000], timeout: 30_000 },
		)
		.toBe(true);
	return last;
}
