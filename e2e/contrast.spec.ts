/**
 * contrast.spec.ts — high contrast (accessibility mode, M27), against the
 * same build and fixtures as the axe checks.
 *
 * - Contrast High paints PALETTE_HC (src/core/palette.ts) in both schemes,
 *   and Standard paints PALETTE again: every palette token, as <html>
 *   resolves it.
 * - High beats a custom background and custom emphasis colors (Appearance
 *   sets those inline on <html>), and Standard gives them back.
 * - The faded neutrals (text-muted-foreground/70 and its kin) are
 *   translucent at Standard and take the full ink at High.
 * - At High, axe's AAA contrast rule (7:1, or 4.5:1 for large text) passes
 *   on every page and every settings section, its disclosures open, in both
 *   schemes (demo frames aside).
 *
 * tests/palette.test.ts checks the ratios themselves; this checks that the
 * browser paints them. A system that asks for more contrast is
 * follow-os.spec's.
 */
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { PALETTE, PALETTE_HC, PALETTE_VARS, VIZ_VARS, type SchemePalette } from "../src/core/palette.ts";
import {
	animationsDone,
	chatReady,
	composerReady,
	computedColor,
	domQuiet,
	expect,
	homeReady,
	hydrated,
	LESSON_CHAT,
	type Mode,
	openDisclosures,
	PRACTICE_CHAT,
	resetAccessibility,
	test,
	withAppearance,
} from "./app.ts";

type Contrast = "standard" | "high";

/** Every palette token, as its CSS variable. */
const TOKENS = [...Object.values(PALETTE_VARS), ...VIZ_VARS];
/** Teaching prose's bold and italic inks (Appearance → emphasis colors). */
const EMPHASIS = ["--lh-ink-strong", "--lh-ink-italic"];
/** A dark custom background (it applies in dark mode) and custom emphasis
 *  colors. */
const CUSTOM = { background: "#2a1830", mdRendering: { boldColor: "#7a3b5c", italicColor: "#4d5a73" } };

const PAGES = [
	{ name: "home", url: "/", ready: homeReady },
	{ name: "new-session", url: "/chat/new", ready: composerReady },
	{ name: "practice", url: `/chat/${PRACTICE_CHAT}`, ready: chatReady },
	{ name: "lesson", url: `/chat/${LESSON_CHAT}`, ready: chatReady },
];

/** Demo frames are left out: a demo is a page the model wrote. A kit demo
 *  gets the high-contrast palette posted in, like the app's other
 *  painters, but a demo from before the house kit keeps its own colors. */
const DEMO_FRAMES = '[data-testid="demo-iframe"]';

test("High paints the high-contrast palette in both schemes, and Standard the standard one", async ({ page }) => {
	await openHome(page);
	try {
		await expect.poll(() => painted(page), { message: "dark, Standard" }).toEqual(expected(PALETTE.dark));
		await chooseContrast(page, "high");
		await expect.poll(() => painted(page), { message: "dark, High" }).toEqual(expected(PALETTE_HC.dark));

		await withAppearance(page, { mode: "light" }, "light", async () => {
			await homeReady(page);
			await expect(page.locator("html"), "High holds across the reload").toHaveAttribute("data-contrast", "high");
			await expect.poll(() => painted(page), { message: "light, High" }).toEqual(expected(PALETTE_HC.light));
			await chooseContrast(page, "standard");
			await expect.poll(() => painted(page), { message: "light, Standard" }).toEqual(expected(PALETTE.light));
		});
	} finally {
		await resetAccessibility(page);
	}
});

test("High beats a custom background and emphasis colors, and Standard gives them back", async ({ page }) => {
	const vars = [...TOKENS, ...EMPHASIS];
	await openHome(page);
	try {
		await withAppearance(page, CUSTOM, "dark", async () => {
			await homeReady(page);
			await expect
				.poll(() => painted(page, ["--background", ...EMPHASIS]), { message: "the custom colors apply" })
				.toEqual({
					"--background": rgb(CUSTOM.background),
					"--lh-ink-strong": rgb(CUSTOM.mdRendering.boldColor),
					"--lh-ink-italic": rgb(CUSTOM.mdRendering.italicColor),
				});
			const custom = await painted(page, vars);

			await chooseContrast(page, "high");
			const ink = rgb(PALETTE_HC.dark.foreground);
			await expect
				.poll(() => painted(page, vars), { message: "High" })
				.toEqual({ ...expected(PALETTE_HC.dark), "--lh-ink-strong": ink, "--lh-ink-italic": ink });

			await chooseContrast(page, "standard");
			await expect.poll(() => painted(page, vars), { message: "Standard, the custom colors again" }).toEqual(custom);
		});
	} finally {
		await resetAccessibility(page);
	}
});

test("the faded neutrals are translucent at Standard and take the full ink at High", async ({ page }) => {
	await page.goto(`/chat/${PRACTICE_CHAT}`);
	await hydrated(page, "dark");
	await chatReady(page);
	try {
		const standard = await faded(page);
		expect(standard.inks.length, "the practice chat shows faded text").toBeGreaterThan(0);
		expect(
			standard.inks.filter((i) => alpha(i.color) === 1),
			"faded text at Standard",
		).toEqual([]);

		await chooseContrast(page, "high");
		const full: Record<string, string> = {
			"text-muted-foreground": await computedColor(page, "var(--muted-foreground)"),
			"text-foreground": await computedColor(page, "var(--foreground)"),
		};
		const border = await computedColor(page, "var(--border)");
		// Only High is checked for the hairlines: at Standard they already
		// paint the full --border, because the unlayered `* { border-color }`
		// rule in app/globals.css outranks every border utility.
		await expect
			.poll(
				async () => {
					const { inks, edges } = await faded(page);
					return [...inks.filter((i) => i.color !== full[i.family]), ...edges.filter((e) => e.color !== border)];
				},
				{ message: "at High, faded text takes the full ink and faded hairlines the full --border" },
			)
			.toEqual([]);
	} finally {
		await resetAccessibility(page);
	}
});

for (const mode of ["dark", "light"] as const) {
	test(`at High, axe's AAA contrast rule passes on every page and settings section (${mode})`, async ({ page }) => {
		test.slow();
		await openHome(page);
		try {
			await chooseContrast(page, "high");
			const scan = async () => {
				for (const { name, url, ready } of PAGES) {
					await test.step(`${name} (${mode})`, async () => {
						await page.goto(url);
						await hydrated(page, mode);
						await ready(page);
						await expect(page.locator("html")).toHaveAttribute("data-contrast", "high");
						await expectAAA(page, `${name} (${mode})`);
					});
				}
				await page.goto("/");
				await homeReady(page);
				await scanSettings(page, mode);
			};
			if (mode === "light") await withAppearance(page, { mode: "light" }, "light", scan);
			else await scan();
		} finally {
			await resetAccessibility(page);
		}
	});
}

async function openHome(page: Page) {
	await page.goto("/");
	await hydrated(page, "dark");
	await homeReady(page);
}

/** Picks Contrast in Settings → Accessibility, as a user does, and waits
 *  until it's saved, applied and cached for the boot script. */
async function chooseContrast(page: Page, contrast: Contrast) {
	await page.getByTestId("settings-entry").click();
	const dialog = page.getByTestId("settings-dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog.getByText("Loading settings…")).toHaveCount(0);
	await dialog.getByTestId("settings-nav-accessibility").click();
	const saved = page.waitForResponse(
		(r) => r.url().endsWith("/api/settings/accessibility") && r.request().method() === "PUT",
	);
	await dialog.getByTestId("select-contrast").selectOption(contrast);
	expect((await saved).ok(), "PUT /api/settings/accessibility").toBe(true);
	await expect(page.locator("html")).toHaveAttribute("data-contrast", contrast);
	await page.waitForFunction(
		(contrast) =>
			(JSON.parse(localStorage.getItem("cairn-a11y") ?? "{}") as { contrast?: string }).contrast === contrast,
		contrast,
	);
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
}

/** Each variable as <html> resolves it, read through a probe's color. */
function painted(page: Page, vars: readonly string[] = TOKENS): Promise<Record<string, string>> {
	return page.evaluate((vars) => {
		const probe = document.createElement("span");
		// Forced colors would repaint the probe itself.
		probe.style.setProperty("forced-color-adjust", "none");
		document.body.append(probe);
		const colors: Record<string, string> = {};
		for (const v of vars) {
			probe.style.color = `var(${v})`;
			colors[v] = getComputedStyle(probe).color;
		}
		probe.remove();
		return colors;
	}, vars);
}

/** What painted() reads while the page paints `p`. */
function expected(p: SchemePalette): Record<string, string> {
	const scalars = (Object.keys(PALETTE_VARS) as (keyof typeof PALETTE_VARS)[]).map((key) => [
		PALETTE_VARS[key],
		rgb(p[key]),
	]);
	const viz = VIZ_VARS.map((v, i) => [v, rgb(p.viz[i]!)]);
	return Object.fromEntries([...scalars, ...viz]);
}

function rgb(hex: string): string {
	const channel = (i: number) => Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
	return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

/** A computed color's alpha: oklab(… / a), rgb(… / a) or rgba(…, a). */
function alpha(color: string): number {
	const match = /\/\s*([\d.]+)\s*\)$/.exec(color) ?? /^rgba\(.*,\s*([\d.]+)\)$/.exec(color);
	return match ? Number(match[1]) : 1;
}

/** The visible elements a faded neutral class sits on (one that begins
 *  the class list or follows a space, as app/globals.css matches them):
 *  the text with its color, the hairlines with their border color. */
function faded(page: Page) {
	return page.evaluate(() => {
		const visible = (el: Element) => {
			const box = el.getBoundingClientRect();
			return box.width > 0 && box.height > 0;
		};
		const classes = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);
		const inks = [
			...document.querySelectorAll(
				'[class^="text-muted-foreground/"], [class*=" text-muted-foreground/"], [class^="text-foreground/"], [class*=" text-foreground/"]',
			),
		]
			.filter(visible)
			.map((el) => {
				const cls = classes(el).find((c) => /^text-(muted-)?foreground\//.test(c)) ?? "";
				return { cls, family: cls.slice(0, cls.indexOf("/")), color: getComputedStyle(el).color };
			});
		const edges = [
			...document.querySelectorAll(
				'[class^="border-border/"], [class*=" border-border/"], [class^="border-muted-foreground/"], [class*=" border-muted-foreground/"]',
			),
		]
			.filter(visible)
			.map((el) => ({
				cls: classes(el).find((c) => /^border-(border|muted-foreground)\//.test(c)) ?? "",
				color: getComputedStyle(el).borderTopColor,
			}));
		return { inks, edges };
	});
}

/** The DOM still for half a second (15 s at most), then the finite
 *  animations done, so axe measures the page at rest. */
async function settle(page: Page) {
	const deadline = Date.now() + 15_000;
	for (let quiet = false; !quiet && Date.now() < deadline; ) quiet = await domQuiet(page, 500);
	await animationsDone(page);
}

/** axe's AAA contrast rule (color-contrast-enhanced) finds nothing; soft,
 *  so one run reports every page. */
async function expectAAA(page: Page, label: string, scope?: string) {
	await settle(page);
	const axe = new AxeBuilder({ page }).withRules(["color-contrast-enhanced"]).exclude(DEMO_FRAMES);
	if (scope) axe.include(scope);
	const { violations } = await axe.analyze();
	const nodes = violations.flatMap((v) => v.nodes.map((n) => `${n.target.join(" ")}: ${n.any[0]?.message ?? v.help}`));
	expect.soft(nodes, `AAA contrast on ${label}`).toEqual([]);
}

/** Every settings section, as the dialog's nav lists them. */
async function scanSettings(page: Page, mode: Mode) {
	await page.getByTestId("settings-entry").click();
	const dialog = page.getByTestId("settings-dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog.getByText("Loading settings…")).toHaveCount(0);
	const ids = await dialog
		.getByTestId("settings-nav")
		.locator('[data-testid^="settings-nav-"]')
		.evaluateAll((buttons) =>
			buttons.map((b) => (b.getAttribute("data-testid") ?? "").slice("settings-nav-".length)),
		);
	expect(ids.length).toBeGreaterThan(0);
	for (const id of ids) {
		await test.step(`settings ${id} (${mode})`, async () => {
			await dialog.getByTestId(`settings-nav-${id}`).click();
			const section = dialog.getByTestId(`section-${id}`);
			await expect(section).toBeVisible();
			await openDisclosures(section);
			await expectAAA(page, `settings ${id} (${mode})`, '[data-testid="settings-dialog"]');
		});
	}
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
}
