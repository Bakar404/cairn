/**
 * reading.spec.ts — reading comfort (accessibility mode, M27), against the
 * same build and fixtures as the axe checks.
 *
 * - The WCAG text-spacing switch gives a lesson's prose the spacing WCAG
 *   1.4.12 tests with (line height 1.5 times the text size, 2 after a
 *   paragraph, 0.12 between letters, 0.16 between words), code keeps its
 *   own, and no text that showed whole before is cut off after. The page's
 *   Reset clears it and keeps focus.
 * - Reading width moves by arrow keys and says its value, caps the prose's
 *   lines once saved, and its own Reset clears it and hands focus to the
 *   slider.
 *
 * Cut off means clipped by a box that hides its overflow. Text a scroll
 * container hides can be scrolled to, so it doesn't count; overlap isn't
 * checked.
 */
import type { Locator, Page } from "@playwright/test";
import {
	chatReady,
	domQuiet,
	expect,
	hydrated,
	LESSON_CHAT,
	openDisclosures,
	resetAccessibility,
	test,
} from "./app.ts";

/** What accessibilityVars (src/core/accessibility.ts) puts on <html>, as
 *  the defaults leave it: the leading always, the rest only once set. */
const DEFAULT_VARS = {
	"--lh-prose-leading": "1.5",
	"--lh-paragraph-spacing": "",
	"--lh-letter-spacing": "",
	"--lh-word-spacing": "",
	"--lh-reading-width": "",
};
/** The lesson's prose in the chat log; an SVG's text is a diagram label. */
const PARAGRAPH = '[role="log"] .lh-prose p:not(:last-child, svg *)';
const HEADING = '[role="log"] .lh-prose :is(h1, h2, h3, h4, h5, h6):not(svg *)';
const CODE = '[role="log"] .lh-prose :is(pre, code)';
/** A computed length can land a hair under the exact product. */
const SLACK_PX = 0.02;

type Spacing = Record<"fontSize" | "lineHeight" | "marginBlockEnd" | "letterSpacing" | "wordSpacing", number>;

test("WCAG text spacing gives a lesson the criterion's spacing and cuts off no text", async ({ page }) => {
	await openLesson(page);
	await settled(page);
	const before = await cutText(page);
	try {
		const dialog = await openAdvanced(page);
		const preset = dialog.getByTestId("preset-wcag-text-spacing");
		await expect(preset).toHaveAccessibleName("WCAG text spacing");
		await expect(preset).toHaveAttribute("aria-checked", "false");
		await saved(page, () => preset.click());
		await expect(preset).toHaveAttribute("aria-checked", "true");
		await expect
			.poll(() => readingVars(page), { message: "the provider sets the spacing" })
			.toEqual({
				...DEFAULT_VARS,
				"--lh-paragraph-spacing": "2em",
				"--lh-letter-spacing": "0.12em",
				"--lh-word-spacing": "0.16em",
			});
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);

		const paragraph = await spacingOf(page, PARAGRAPH);
		atLeast(paragraph, "lineHeight", 1.5, "a paragraph's line height");
		atLeast(paragraph, "marginBlockEnd", 2, "the space after a paragraph");
		atLeast(paragraph, "letterSpacing", 0.12, "a paragraph's letter spacing");
		atLeast(paragraph, "wordSpacing", 0.16, "a paragraph's word spacing");
		const heading = await spacingOf(page, HEADING);
		atLeast(heading, "letterSpacing", 0.12, "a heading's letter spacing");
		atLeast(heading, "wordSpacing", 0.16, "a heading's word spacing");
		expect((await spacingOf(page, CODE)).letterSpacing, "code keeps its own letter spacing").toBe(0);

		await settled(page);
		expect(newlyCut(before, await cutText(page)), "text the spacing cuts off").toEqual([]);

		const reset = (await openAdvanced(page)).getByTestId("a11y-reset");
		await saved(page, () => reset.click());
		await expect(reset, "Reset keeps focus").toBeFocused();
		await expect.poll(() => readingVars(page), { message: "the spacing is gone" }).toEqual(DEFAULT_VARS);
	} finally {
		await resetAccessibility(page);
	}
});

test("Reading width moves by arrow keys, caps the prose once saved, and its Reset hands focus to the slider", async ({ page }) => {
	await openLesson(page);
	try {
		const dialog = await openAdvanced(page);
		const slider = dialog.getByTestId("slider-reading-width");
		await expect(slider).toHaveAttribute("aria-valuetext", "Full width");
		await slider.focus();
		// Three steps, one write: it waits for the thumb to settle.
		await saved(page, async () => {
			for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
		});
		await expect(slider).toHaveAttribute("aria-valuetext", "80 characters");
		await expect
			.poll(async () => (await readingVars(page))["--lh-reading-width"], { message: "the provider sets the cap" })
			.toBe("80ch");
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
		const capped = await widthOf(page);
		expect(capped.max, "the cap is 80 characters of the prose's font").toBeCloseTo(capped.ch80, 0);
		expect(capped.width, "and a paragraph keeps to it").toBeLessThanOrEqual((capped.max ?? 0) + 0.5);

		const again = await openAdvanced(page);
		const reset = again.getByTestId("slider-reading-width-reset");
		await saved(page, () => reset.click());
		const reopened = again.getByTestId("slider-reading-width");
		await expect(reopened, "Reset hands focus to its slider").toBeFocused();
		await expect(reopened).toHaveAttribute("aria-valuetext", "Full width");
		await expect(reset, "with nothing left to reset, Reset hides").toBeHidden();
		await expect
			.poll(async () => (await readingVars(page))["--lh-reading-width"], { message: "the cap is gone" })
			.toBe("");
		expect((await widthOf(page)).max, "a paragraph runs the full column").toBeNull();
	} finally {
		await resetAccessibility(page);
	}
});

async function openLesson(page: Page) {
	await page.goto(`/chat/${LESSON_CHAT}`);
	await hydrated(page, "dark");
	await chatReady(page);
}

/** Waits for the web fonts, then for the DOM to go half a second without a
 *  change: diagrams and math draw after the messages. */
async function settled(page: Page) {
	await page.evaluate(async () => {
		await document.fonts.ready;
	});
	await expect.poll(() => domQuiet(page, 500), { message: "the page settles", timeout: 20_000 }).toBe(true);
}

/** Opens Settings → Accessibility with Advanced open. */
async function openAdvanced(page: Page): Promise<Locator> {
	await page.getByTestId("settings-entry").click();
	const dialog = page.getByTestId("settings-dialog");
	await expect(dialog.getByText("Loading settings…")).toHaveCount(0);
	await dialog.getByTestId("settings-nav-accessibility").click();
	const section = dialog.getByTestId("section-accessibility");
	await expect(section).toBeVisible();
	await openDisclosures(section);
	await expect(section.getByTestId("a11y-advanced-toggle")).toHaveAttribute("aria-expanded", "true");
	return dialog;
}

/** Runs `act` and waits for the accessibility section's PUT it causes. */
async function saved(page: Page, act: () => Promise<void>) {
	const put = page.waitForResponse(
		(r) => r.url().endsWith("/api/settings/accessibility") && r.request().method() === "PUT",
	);
	await act();
	expect((await put).ok(), "PUT /api/settings/accessibility").toBe(true);
}

/** The reading variables on <html>, "" while unset. */
function readingVars(page: Page): Promise<Record<string, string>> {
	return page.evaluate((names) => {
		const style = getComputedStyle(document.documentElement);
		return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name).trim()]));
	}, Object.keys(DEFAULT_VARS));
}

/** The computed spacing of the first element `selector` matches, in px
 *  ("normal" is 0). */
async function spacingOf(page: Page, selector: string): Promise<Spacing> {
	const el = page.locator(selector).first();
	await expect(el, `the lesson has ${selector}`).toBeAttached();
	return el.evaluate((el) => {
		const s = getComputedStyle(el);
		const px = (value: string) => (value === "normal" ? 0 : Number.parseFloat(value));
		return {
			fontSize: px(s.fontSize),
			lineHeight: px(s.lineHeight),
			marginBlockEnd: px(s.marginBlockEnd),
			letterSpacing: px(s.letterSpacing),
			wordSpacing: px(s.wordSpacing),
		};
	});
}

function atLeast(spacing: Spacing, field: keyof Spacing, times: number, what: string) {
	expect(
		spacing[field],
		`${what}: ${spacing[field]}px, against ${times} × ${spacing.fontSize}px`,
	).toBeGreaterThanOrEqual(times * spacing.fontSize - SLACK_PX);
}

/** A paragraph's cap (null for none), its width, and 80ch in its font. */
async function widthOf(page: Page) {
	return page
		.locator(PARAGRAPH)
		.first()
		.evaluate((p) => {
			const probe = document.createElement("span");
			probe.style.cssText = "display: inline-block; inline-size: 80ch";
			p.append(probe);
			const ch80 = probe.getBoundingClientRect().width;
			probe.remove();
			const max = getComputedStyle(p).maxInlineSize;
			return { max: max === "none" ? null : Number.parseFloat(max), width: p.getBoundingClientRect().width, ch80 };
		});
}

/**
 * Every text node a box hiding its overflow cuts off, as
 * `clipper > parent "text"`. Each text node is measured line by line
 * against the boxes it sits in, nearest first; a scroll container frees its
 * axes (the text can be scrolled to), and a box of a pixel or less is a
 * visually hidden label, whose text doesn't count.
 */
function cutText(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		type Axis = "clip" | "scroll" | "free";
		type Clip = { x: Axis; y: Axis; left: number; top: number; right: number; bottom: number; tiny: boolean };
		const axis = (overflow: string): Axis =>
			overflow === "hidden" || overflow === "clip" ? "clip" : overflow === "visible" ? "free" : "scroll";
		const clips = new Map<Element, Clip | null>();
		/** The element's overflow per axis and its padding box, null when it
		 *  hides and scrolls nothing (inline boxes ignore overflow). */
		const clipOf = (el: Element): Clip | null => {
			const known = clips.get(el);
			if (known !== undefined) return known;
			const s = getComputedStyle(el);
			const x = axis(s.overflowX);
			const y = axis(s.overflowY);
			let clip: Clip | null = null;
			const inline = s.display === "contents" || (s.display === "inline" && el instanceof HTMLElement);
			if (!inline && (x !== "free" || y !== "free")) {
				const r = el.getBoundingClientRect();
				if (el instanceof HTMLElement) {
					// A scaled box: its client sizes are before the transform.
					const sx = el.offsetWidth ? r.width / el.offsetWidth : 1;
					const sy = el.offsetHeight ? r.height / el.offsetHeight : 1;
					const left = r.left + el.clientLeft * sx;
					const top = r.top + el.clientTop * sy;
					const right = left + el.clientWidth * sx;
					const bottom = top + el.clientHeight * sy;
					clip = { x, y, left, top, right, bottom, tiny: el.clientWidth <= 1 && el.clientHeight <= 1 };
				} else {
					clip = { x, y, left: r.left, top: r.top, right: r.right, bottom: r.bottom, tiny: r.width <= 1 && r.height <= 1 };
				}
			}
			clips.set(el, clip);
			return clip;
		};
		const describe = (el: Element) => {
			const testid = el.getAttribute("data-testid");
			const classes = [...el.classList].slice(0, 3).map((c) => `.${c}`).join("");
			return `${el.tagName.toLowerCase()}${testid ? `[${testid}]` : ""}${classes}`;
		};

		const cut: string[] = [];
		const range = document.createRange();
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		nodes: for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
			const parent = node.parentElement;
			if (!text || !parent) continue;
			range.selectNodeContents(node);
			const lines = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
			if (lines.length === 0 || getComputedStyle(parent).visibility === "hidden") continue;
			let freeX = false;
			let freeY = false;
			for (let el: Element | null = parent; el && !(freeX && freeY); el = el.parentElement) {
				const clip = clipOf(el);
				if (!clip) continue;
				if (clip.tiny) continue nodes;
				const outX =
					!freeX && clip.x === "clip" && lines.some((r) => r.left < clip.left - 1 || r.right > clip.right + 1);
				const outY =
					!freeY && clip.y === "clip" && lines.some((r) => r.top < clip.top - 1 || r.bottom > clip.bottom + 1);
				if (outX || outY) {
					cut.push(`${describe(el)} > ${parent.tagName.toLowerCase()} "${text.slice(0, 40)}"`);
					continue nodes;
				}
				if (clip.x === "scroll") freeX = true;
				if (clip.y === "scroll") freeY = true;
			}
		}
		return cut;
	});
}

/** What `after` cuts off that `before` didn't, counting repeats. */
function newlyCut(before: string[], after: string[]): string[] {
	const left = new Map<string, number>();
	for (const entry of before) left.set(entry, (left.get(entry) ?? 0) + 1);
	return after.filter((entry) => {
		const n = left.get(entry) ?? 0;
		if (n > 0) left.set(entry, n - 1);
		return n === 0;
	});
}
