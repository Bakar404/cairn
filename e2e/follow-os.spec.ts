/**
 * follow-os.spec.ts — following the OS (accessibility mode, M27), against
 * the same build and fixtures as the axe checks.
 *
 * - What the OS asks for reaches <html> live, as the data-os-* attributes,
 *   whatever the settings say.
 * - With "Follow system accessibility settings" on (the default), more
 *   contrast raises the app's contrast (the Contrast row says so) and
 *   reduced transparency makes the translucent surfaces solid. Off, both
 *   stay standard. The boot script applies the same rule before the
 *   settings arrive.
 * - Forced colors are always honored: the switch shows its state in system
 *   colors, a chosen option (current, pressed or selected) fills with
 *   Highlight, a list's arrow-walk cursor is outlined, and the app's own
 *   contrast stays put.
 * - The desktop app's nativeTheme flags arrive through window.lh (pulled,
 *   then pushed), stubbed here as the preload would expose them.
 *
 * Runs in the default project only: each test emulates what it needs, on
 * top of the baseline app.ts pins (no OS preference, transparency too).
 */
import type { Locator, Page } from "@playwright/test";
import type { ModelCatalogEntry, ModelCatalogResponse } from "../src/core/contracts/models.ts";
import {
	chatReady,
	computedColor,
	expect,
	homeReady,
	hydrated,
	LESSON_CHAT,
	resetAccessibility,
	test,
} from "./app.ts";

test("more contrast from the OS raises the app's, live and from the boot script, until Follow system is off", async ({ page }) => {
	await openHome(page);
	const html = page.locator("html");
	await expect(html).toHaveAttribute("data-os-contrast", "no-preference");
	await expect(html).toHaveAttribute("data-contrast", "standard");
	try {
		await page.emulateMedia({ contrast: "more" });
		await expect(html, "the OS asks, live").toHaveAttribute("data-os-contrast", "more");
		await expect(html, "Follow system is on by default").toHaveAttribute("data-contrast", "high");
		expect(await bootAttribute(page, "data-contrast"), "the boot script asks the OS too").toBe("high");

		const dialog = await openAccessibility(page);
		const row = dialog.getByTestId("row-contrast");
		await expect(row.getByTestId("select-contrast"), "the saved choice stays").toHaveValue("standard");
		await expect(row, "and the row says why it's high").toContainText("High for now: your system asks for more contrast");
		await toggleFollowSystem(page, dialog, false);
		await expect(row).not.toContainText("High for now");
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
		await expect(html, "the OS still asks").toHaveAttribute("data-os-contrast", "more");
		await expect(html).toHaveAttribute("data-contrast", "standard");
		expect(await bootAttribute(page, "data-contrast"), "the boot script reads the saved switch").toBe("standard");
	} finally {
		await resetAccessibility(page);
	}
});

test("less transparency from the OS makes the floating surfaces and the dialog scrim solid, until Follow system is off", async ({ page, transparency }) => {
	await openHome(page);
	const html = page.locator("html");
	await expect(html).toHaveAttribute("data-transparency", "standard");
	const toolbar = page.locator('[class*="bg-card/85"][class*="backdrop-blur"]').first();
	await expect(toolbar).toBeVisible();
	const card = await computedColor(page, "var(--card)");
	const background = await computedColor(page, "var(--background)");
	const translucent = await surface(toolbar);
	expect(translucent.background, "bg-card/85 lets the page through").not.toBe(card);
	expect(translucent.backdrop, "and blurs it").not.toBe("none");
	try {
		await transparency("reduce");
		await expect(html, "the OS asks, live").toHaveAttribute("data-os-transparency", "reduce");
		await expect(html, "Follow system is on by default").toHaveAttribute("data-transparency", "reduced");
		await expect.poll(() => surface(toolbar), { message: "the toolbar is solid" }).toEqual({ background: card, backdrop: "none" });
		expect(await bootAttribute(page, "data-transparency"), "the boot script asks the OS too").toBe("reduced");

		const dialog = await openAccessibility(page);
		await expect
			.poll(() => surface(page.getByTestId("settings-backdrop")), { message: "the dialog scrim is solid" })
			.toEqual({ background, backdrop: "none" });
		await toggleFollowSystem(page, dialog, false);
		await expect(html, "the OS still asks").toHaveAttribute("data-os-transparency", "reduce");
		await expect(html).toHaveAttribute("data-transparency", "standard");
		await expect.poll(() => surface(toolbar), { message: "translucent again" }).toEqual(translucent);
	} finally {
		await resetAccessibility(page);
	}
});

test("under forced colors the switch shows its state in system colors, and the app's contrast stays put", async ({ page }) => {
	await openHome(page);
	await page.emulateMedia({ forcedColors: "active" });
	const html = page.locator("html");
	await expect(html).toHaveAttribute("data-os-forced-colors", "active");
	await expect(html, "forced colors replace the palette; they don't raise it").toHaveAttribute("data-contrast", "standard");
	const [highlight, highlightText, buttonFace, buttonText] = await Promise.all(
		["Highlight", "HighlightText", "ButtonFace", "ButtonText"].map((color) => computedColor(page, color)),
	);
	try {
		const dialog = await openAccessibility(page);
		const toggle = dialog.getByTestId("toggle-follow-system-accessibility-settings");
		await expect(toggle).toHaveAttribute("aria-checked", "true");
		await expect.poll(() => switchColors(toggle), { message: "on" }).toEqual({ track: highlight, disc: highlightText });
		await toggleFollowSystem(page, dialog, false);
		await expect.poll(() => switchColors(toggle), { message: "off" }).toEqual({ track: buttonFace, disc: buttonText });
	} finally {
		await resetAccessibility(page);
	}
});

test("under forced colors a pressed or current option fills with Highlight, and the model menu's walk cursor is outlined", async ({ page }) => {
	// The menu's rows are fixed: CI is signed out of GitHub Copilot (an
	// empty catalog) and a developer's machine may not be.
	await page.route("**/api/models", async (route) => {
		const response = await route.fetch();
		const catalog = (await response.json()) as ModelCatalogResponse;
		await route.fulfill({ response, json: { ...catalog, models: MENU_MODELS } });
	});
	await openHome(page);
	await page.emulateMedia({ forcedColors: "active" });
	const [highlight, highlightText] = await Promise.all(
		["Highlight", "HighlightText"].map((color) => computedColor(page, color)),
	);
	const filled = { background: highlight, color: highlightText };

	const teach = page.getByTestId("home-mode-teach");
	await expect(teach).toHaveAttribute("aria-pressed", "true");
	await expect.poll(() => paint(teach), { message: "the pressed mode" }).toMatchObject(filled);
	expect((await paint(page.getByTestId("home-mode-practice"))).background, "the other mode").not.toBe(highlight);

	// The cursor walks while focus stays in the search field. A current row
	// pairs the fill with a HighlightText outline (the lesson test covers
	// that), so neither fixed row is the current model.
	await page.getByTestId("stats-model").click();
	const menu = page.getByTestId("model-menu");
	const search = page.getByTestId("model-search");
	const walked = menu.locator("[data-highlighted]");
	await expect(menu.locator('[data-testid^="model-option-"]')).toHaveCount(MENU_MODELS.length);
	await search.press("ArrowDown");
	await expect(walked).toHaveCount(1);
	await expect(walked).not.toHaveAttribute("aria-current", "true");
	await expect.poll(() => paint(walked), { message: "the walked row" }).toMatchObject({ outline: `dashed ${highlight}` });
	await page.keyboard.press("Escape");
	await expect(menu).toHaveCount(0);

	const dialog = await openAccessibility(page);
	await expect
		.poll(() => paint(dialog.getByTestId("settings-nav-accessibility")), { message: "the open section" })
		.toMatchObject(filled);
	const others = await dialog.getByTestId("settings-nav").locator('[aria-current="false"]').all();
	expect(others.length, "the other sections").toBeGreaterThan(0);
	for (const other of others) expect((await paint(other)).background, 'aria-current="false"').not.toBe(highlight);
});

test("under forced colors the open lesson's row and the learner's answers fill with Highlight, and a walk onto the row outlines inside the fill", async ({ page }) => {
	await page.goto(`/chat/${LESSON_CHAT}`);
	await hydrated(page, "dark");
	await chatReady(page);
	await page.emulateMedia({ forcedColors: "active" });
	const [highlight, highlightText] = await Promise.all(
		["Highlight", "HighlightText"].map((color) => computedColor(page, color)),
	);
	const filled = { background: highlight, color: highlightText };

	// A walked row's testid becomes session-row-kbd; the prefix keeps both.
	const rows = page.locator('[data-testid^="session-row"]');
	const open = rows.and(page.locator('[aria-current="page"]'));
	await expect(open, "the open lesson's row").toHaveCount(1);
	await expect.poll(() => paint(open), { message: "the open lesson" }).toMatchObject(filled);

	const chosen = page.getByTestId("answered-card").locator("[data-selected]");
	await expect(chosen.first(), "the lesson has answered questions").toBeVisible();
	await expect.poll(() => paint(chosen.first()), { message: "the learner's answer" }).toMatchObject(filled);

	// ↓ from no cursor lands on the first row, then one row per press.
	const index = await rows.evaluateAll((all) => all.findIndex((row) => row.getAttribute("aria-current") === "page"));
	const search = page.getByTestId("session-search");
	for (let i = 0; i <= index; i++) await search.press("ArrowDown");
	await expect(open).toHaveAttribute("data-highlighted", "");
	await expect
		.poll(() => paint(open), { message: "open and walked: the outline turns HighlightText to show on the fill" })
		.toEqual({ ...filled, outline: `dashed ${highlightText}` });
});

test("the desktop app's flags arrive pulled, then pushed, and differentiate without color underlines every link", async ({ page }) => {
	await page.addInitScript(() => {
		type Flags = Record<string, boolean>;
		const listeners = new Set<(flags: Flags) => void>();
		const w = window as unknown as { lh: object; pushSystem: (flags: Flags) => void };
		w.lh = {
			getSystemAccessibility: () => Promise.resolve({ invertedColors: true }),
			onSystemAccessibility: (cb: (flags: Flags) => void) => {
				listeners.add(cb);
				return () => listeners.delete(cb);
			},
		};
		w.pushSystem = (flags) => {
			for (const cb of listeners) cb(flags);
		};
	});
	await openHome(page);
	const html = page.locator("html");
	await expect(html, "the pull").toHaveAttribute("data-os-inverted", "inverted");
	await expect(html).toHaveAttribute("data-os-differentiate", "no-preference");
	await expect(html).toHaveAttribute("data-contrast", "standard");

	await page.evaluate(() =>
		(window as unknown as { pushSystem: (flags: object) => void }).pushSystem({
			highContrast: true,
			differentiateWithoutColor: true,
		}),
	);
	await expect(html, "a push replaces the flags").toHaveAttribute("data-os-inverted", "none");
	await expect(html).toHaveAttribute("data-os-differentiate", "without-color");
	await expect(html, "a high-contrast theme asks for more contrast").toHaveAttribute("data-os-contrast", "more");
	await expect(html, "and Follow system raises the app's").toHaveAttribute("data-contrast", "high");
	const links = await page.evaluate(() =>
		[...document.querySelectorAll("a[href]")].map((a) => getComputedStyle(a).textDecorationLine),
	);
	expect(links.length, "the home page has links").toBeGreaterThan(0);
	expect(new Set(links), "every link is underlined").toEqual(new Set(["underline"]));
});

async function openHome(page: Page) {
	await page.goto("/");
	await hydrated(page, "dark");
	await homeReady(page);
}

/** Two model-menu rows for the walk, neither of them the fixtures' strong
 *  slot. */
const MENU_MODELS: ModelCatalogEntry[] = [menuModel("fixture-model-a", "Fixture model A"), menuModel("fixture-model-b", "Fixture model B")];

function menuModel(id: string, name: string): ModelCatalogEntry {
	return {
		id,
		name,
		provider: "copilot",
		reasoning: false,
		input: ["text"],
		supportedLevels: [],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_000,
	};
}

async function openAccessibility(page: Page): Promise<Locator> {
	await page.getByTestId("settings-entry").click();
	const dialog = page.getByTestId("settings-dialog");
	await expect(dialog.getByText("Loading settings…")).toHaveCount(0);
	await dialog.getByTestId("settings-nav-accessibility").click();
	return dialog;
}

/** Flips Follow system in the open dialog, as a user does, and waits until
 *  it's saved and cached for the boot script. */
async function toggleFollowSystem(page: Page, dialog: Locator, on: boolean) {
	const toggle = dialog.getByTestId("toggle-follow-system-accessibility-settings");
	await expect(toggle).toHaveAttribute("aria-checked", String(!on));
	const saved = page.waitForResponse(
		(r) => r.url().endsWith("/api/settings/accessibility") && r.request().method() === "PUT",
	);
	await toggle.click();
	expect((await saved).ok(), "PUT /api/settings/accessibility").toBe(true);
	await expect(toggle).toHaveAttribute("aria-checked", String(on));
	await page.waitForFunction(
		(on) => (JSON.parse(localStorage.getItem("cairn-a11y") ?? "{}") as { followSystem?: boolean }).followSystem === on,
		on,
	);
}

/** An <html> attribute as the boot script alone paints it: the next load
 *  with the settings request failing, so the provider never applies. Then
 *  a normal load again. */
async function bootAttribute(page: Page, name: string): Promise<string | null> {
	await page.route("**/api/settings", (route) => route.abort());
	await page.reload({ waitUntil: "domcontentloaded" });
	const value = await page.locator("html").getAttribute(name);
	await page.unroute("**/api/settings");
	await openHome(page);
	return value;
}

function surface(el: Locator) {
	return el.evaluate((el) => {
		const s = getComputedStyle(el);
		return { background: s.backgroundColor, backdrop: s.backdropFilter };
	});
}

function switchColors(toggle: Locator) {
	return toggle.evaluate((el) => ({
		track: getComputedStyle(el).backgroundColor,
		disc: getComputedStyle(el.querySelector("span") ?? el).backgroundColor,
	}));
}

function paint(el: Locator) {
	return el.evaluate((el) => {
		const s = getComputedStyle(el);
		return { background: s.backgroundColor, color: s.color, outline: `${s.outlineStyle} ${s.outlineColor}` };
	});
}
