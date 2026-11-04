/**
 * keyboard.spec.ts — keyboard access and visible focus (accessibility mode,
 * M27), against the same build and fixtures as the axe checks.
 *
 * - Tab reaches every tab stop on home, in a practice chat and on every
 *   Settings page (with its disclosures shut, then open), and never leaves
 *   an open dialog, either way round.
 * - Closing a dialog gives focus back to the control that opened it.
 * - The focus outline draws after Tab or F6, never after a click or an
 *   arrow key, and a tooltip opens on keyboard focus only.
 * - The Enhanced focus indicator (Settings → Accessibility) thickens the
 *   outline, and the boot script paints it on the next load.
 * - The shortcut editor refuses Tab and F6, and F6 walks a chat's fields.
 *
 * A tab stop is what the dialog trap counts: TABBABLE, filtered the way
 * tabbables() in components/use-dialog-focus.ts filters it. The browser may
 * add stops of its own (a scroll container with nothing focusable inside),
 * which the walks allow.
 */
import type { Page } from "@playwright/test";
import { TABBABLE } from "../components/use-dialog-focus.ts";
import { chatReady, computedColor, expect, homeReady, hydrated, openDisclosures, PRACTICE_CHAT, test } from "./app.ts";

const SETTINGS = '[data-testid="settings-dialog"]';
/** The chat's F6 chain, in order (cycleChatFields in components/chat.tsx). */
const CHAT_FIELDS = ["reading-thinking-field", "question-dock", "practice-dock", "composer"];

type TabKey = "Tab" | "Shift+Tab";

test("Tab reaches every control on home", async ({ page }) => {
	await openHome(page);
	await walkPage(page);
});

test("Tab reaches every control in a practice chat", async ({ page }) => {
	await openPractice(page);
	await walkPage(page);
});

test("Tab stays inside Settings on every page, and Esc gives focus back", async ({ page }) => {
	test.slow();
	await openHome(page);
	const entry = page.getByTestId("settings-entry");
	await entry.focus();
	await page.keyboard.press("Enter");
	const dialog = page.getByTestId("settings-dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog.getByText("Loading settings…")).toHaveCount(0);
	await expect
		.poll(async () => (await focusAt(page, SETTINGS)).inside, { message: "focus moves into the dialog" })
		.toBe(true);

	const ids = await dialog
		.getByTestId("settings-nav")
		.locator('[data-testid^="settings-nav-"]')
		.evaluateAll((buttons) =>
			buttons.map((b) => (b.getAttribute("data-testid") ?? "").slice("settings-nav-".length)),
		);
	expect(ids.length).toBeGreaterThan(0);
	for (const id of ids) {
		await test.step(id, async () => {
			await dialog.getByTestId(`settings-nav-${id}`).click();
			const section = dialog.getByTestId(`section-${id}`);
			await expect(section).toBeVisible();
			for (const key of ["Tab", "Shift+Tab"] as const) {
				expect.soft(await walk(page, SETTINGS, key, true), `${key} through ${id}: stops never reached`).toEqual([]);
			}
			if ((await openDisclosures(section)) === 0) return;
			for (const key of ["Tab", "Shift+Tab"] as const) {
				expect
					.soft(await walk(page, SETTINGS, key, true), `${key} through ${id}, opened: stops never reached`)
					.toEqual([]);
			}
		});
	}

	// From a nav button: a section's own field may claim Esc while it has focus.
	await dialog.getByTestId(`settings-nav-${ids[0]}`).click();
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(entry).toBeFocused();
});

test("the cheat sheet keeps focus until Esc gives it back", async ({ page }) => {
	await openHome(page);
	const entry = page.getByTestId("settings-entry");
	await entry.focus();
	await page.keyboard.press("?");
	const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
	await expect(sheet).toBeFocused();
	for (const key of ["Tab", "Shift+Tab", "F6"]) {
		await page.keyboard.press(key);
		await expect(sheet, `after ${key}`).toBeFocused();
	}
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("cheat-sheet")).toHaveCount(0);
	await expect(entry).toBeFocused();
});

test("the focus outline shows after Tab or F6, not after a click or an arrow key", async ({ page }) => {
	await openHome(page);
	const topic = page.getByPlaceholder("What do you want to learn?");
	await topic.focus();
	await page.keyboard.press("Tab");
	expect(await modality(page)).toBe("keyboard");
	const on = await describe(page, "*:focus");
	expect(await outline(page), `the outline on ${on}`).toEqual({
		style: "solid",
		width: "2px",
		offset: "2px",
		color: await computedColor(page, "var(--primary)"),
	});

	await page.emulateMedia({ forcedColors: "active" });
	expect((await outline(page)).color, `the forced-colors outline on ${on}`).toBe(
		await computedColor(page, "Highlight"),
	);
	await page.emulateMedia({ forcedColors: "none" });

	await topic.click();
	expect(await modality(page)).toBe("pointer");
	expect((await outline(page)).style, "after a click").toBe("none");
	await page.keyboard.press("ArrowLeft");
	await page.keyboard.press("ArrowRight");
	expect((await outline(page)).style, "after a click, then ←/→").toBe("none");

	const teach = page.getByTestId("home-mode-teach");
	await teach.click();
	await page.keyboard.press("ArrowRight");
	await expect(teach).toBeFocused();
	expect((await outline(page)).style, "on a clicked button, after →").toBe("none");

	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	await page.keyboard.press("F6");
	await expect(topic).toBeFocused();
	expect(await modality(page)).toBe("keyboard");
	expect((await outline(page)).style, "after F6").toBe("solid");
});

test("the Enhanced focus indicator thickens the outline, and the next load paints it before settings arrive", async ({ page }) => {
	await openHome(page);
	const html = page.locator("html");
	await expect(html).toHaveAttribute("data-focus", "standard");
	await page.getByTestId("settings-entry").click();
	const dialog = page.getByTestId("settings-dialog");
	await expect(dialog.getByText("Loading settings…")).toHaveCount(0);
	try {
		await dialog.getByTestId("settings-nav-accessibility").click();
		await dialog.getByTestId("select-focus").selectOption("enhanced");
		await expect(html).toHaveAttribute("data-focus", "enhanced");
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);

		await page.getByPlaceholder("What do you want to learn?").focus();
		await page.keyboard.press("Tab");
		const on = await describe(page, "*:focus");
		expect(await outline(page), `the enhanced outline on ${on}`).toMatchObject({
			style: "solid",
			width: "4px",
			offset: "3px",
		});

		// With the settings request failing, the provider never applies:
		// only the boot script can have set it.
		await page.route("**/api/settings", (route) => route.abort());
		await page.reload({ waitUntil: "domcontentloaded" });
		expect(await html.getAttribute("data-focus"), "before the settings load").toBe("enhanced");
	} finally {
		const res = await page.request.put("/api/settings/accessibility", { data: {} });
		expect(res.ok(), `PUT /api/settings/accessibility: ${res.status()}`).toBe(true);
	}
});

test("a tooltip opens on keyboard focus, not on focus after a click", async ({ page }) => {
	await openHome(page);
	const entry = page.getByTestId("settings-entry");
	const dialog = page.getByTestId("settings-dialog");
	const tip = page.locator('[data-slot="tooltip-content"]', { hasText: "Settings (" });
	await entry.click();
	await expect(dialog).toBeVisible();
	await page.mouse.move(1270, 710);
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(entry).toBeFocused();
	// The dialog's restore runs inside a React commit, which never reaches
	// the tooltip; focus from outside one does (the window coming back to
	// the front, a script). This is that case.
	await entry.evaluate((el) => {
		el.blur();
		el.focus();
	});
	// Past the 500 ms hover delay, so a late open would have shown.
	await page.waitForTimeout(1000);
	await expect(tip).toHaveCount(0);

	await page.keyboard.press("Shift+Tab");
	await page.keyboard.press("Tab");
	await expect(entry).toBeFocused();
	await expect(tip).toBeVisible();
});

test("the shortcut editor refuses Tab and F6", async ({ page }) => {
	await openHome(page);
	await page.getByTestId("settings-entry").click();
	const dialog = page.getByTestId("settings-dialog");
	await expect(dialog.getByText("Loading settings…")).toHaveCount(0);
	await dialog.getByTestId("settings-nav-keyboard").click();
	const keys = dialog.getByTestId("kbd-row-open-model-picker").locator("kbd");
	const rebind = dialog.getByTestId("kbd-rebind-open-model-picker");
	const refused = dialog.getByTestId("kbd-refused-open-model-picker");

	await rebind.click();
	await expect(keys).toHaveText("Press keys…");
	await page.keyboard.press("Tab");
	await expect(refused).toHaveText("Tab moves focus, so it can't be a shortcut. Press another key, or Esc to cancel.");
	await page.keyboard.press("F6");
	await expect(refused).toHaveText(
		"F6 moves between text fields, so it can't be a shortcut. Press another key, or Esc to cancel.",
	);
	expect(await keymap(page)).toBeNull();

	await page.keyboard.press("Escape");
	await expect(rebind).toBeFocused();
	await expect(dialog).toBeVisible();

	await page.keyboard.press("Enter");
	await expect(keys).toHaveText("Press keys…");
	await page.keyboard.press("Control+Shift+Y");
	await expect(rebind).toBeFocused();
	await expect(keys).toHaveText(/^(Ctrl\+Shift\+Y|⌘⇧Y)$/);
	expect(await keymap(page)).toEqual({ "open-model-picker": "mod+shift+y" });

	await dialog.getByTestId("kbd-reset-open-model-picker").click();
	await expect(keys).toHaveText(/^(Ctrl\+K|⌘K)$/);
	expect(await keymap(page)).toBeNull();
});

// The golden chats are finished, so no check waits and the chain is the
// composer alone; a longer chain's order is pinned by nextFieldIndex's unit
// tests (tests/focus-navigation.test.ts). This covers the wiring.
test("F6 and Shift+F6 move into a chat's text fields from anywhere, and walk them", async ({ page }) => {
	await openPractice(page);
	const outside = page.getByTestId("settings-entry");
	await outside.focus();
	const chain: string[] = [];
	let wrapped = false;
	for (let i = 0; i < CHAT_FIELDS.length + 2 && !wrapped; i++) {
		await page.keyboard.press("F6");
		const field = await focusedField(page);
		if (field === chain[0]) wrapped = true;
		else chain.push(field);
	}
	const order = chain.join(" → ");
	expect(wrapped, `F6 never came back to the first field: ${order}`).toBe(true);
	expect(new Set(chain).size, `a field twice: ${order}`).toBe(chain.length);
	expect(chain.some((field) => field.startsWith("composer#")), `no composer: ${order}`).toBe(true);
	expect(await modality(page)).toBe("keyboard");

	// From the first field, Shift+F6 wraps to the last and walks back.
	for (const expected of [...chain].reverse()) {
		await page.keyboard.press("Shift+F6");
		expect(await focusedField(page), order).toBe(expected);
	}

	await outside.focus();
	await page.keyboard.press("Shift+F6");
	expect(await focusedField(page), `Shift+F6 from outside: ${order}`).toBe(chain.at(-1));
});

async function openHome(page: Page) {
	await page.goto("/");
	await hydrated(page, "dark");
	await homeReady(page);
	await expect(page.getByTestId("session-row").first()).toBeVisible();
}

async function openPractice(page: Page) {
	await page.goto(`/chat/${PRACTICE_CHAT}`);
	await hydrated(page, "dark");
	await chatReady(page);
}

/** Tabs from the page's first stop until every stop has had focus. */
async function walkPage(page: Page) {
	const stops = await liveStops(page, "body");
	expect(stops.length).toBeGreaterThan(0);
	await page.locator(stopAt(stops[0]!)).focus();
	expect(await walk(page, "body", "Tab", false), "stops Tab never reached").toEqual([]);
}

const stopAt = (mark: string) => `[data-e2e-stop="${mark}"]`;

/** Marks the tab stops under `root` that have no mark yet (data-e2e-stop,
 *  numbered for the page's life, so a mark always means one element) and
 *  returns every current stop's mark, in DOM order. */
async function liveStops(page: Page, root: string): Promise<string[]> {
	return page.evaluate(
		([root, selector]) => {
			const scope = document.querySelector(root);
			if (!scope) throw new Error(`nothing matches ${root}`);
			const counter = window as Window & { e2eStops?: number };
			return Array.from(scope.querySelectorAll<HTMLElement>(selector))
				.filter(
					(el) =>
						el.tabIndex >= 0 &&
						!el.closest("[inert]") &&
						el.getClientRects().length > 0 &&
						getComputedStyle(el).visibility !== "hidden",
				)
				.map((el) => {
					let mark = el.dataset.e2eStop;
					if (mark === undefined) {
						counter.e2eStops = (counter.e2eStops ?? 0) + 1;
						mark = String(counter.e2eStops);
						el.dataset.e2eStop = mark;
					}
					return mark;
				});
		},
		[root, TABBABLE] as const,
	);
}

/** Where focus is: its stop mark, if any, and whether it's on the page body
 *  or inside `root`. */
async function focusAt(page: Page, root: string) {
	return page.evaluate((root) => {
		const el = document.activeElement;
		return {
			stop: el?.getAttribute("data-e2e-stop") ?? null,
			body: !el || el === document.body,
			inside: !!el && !!document.querySelector(root)?.contains(el),
		};
	}, root);
}

/**
 * Presses `key` until every tab stop under `root` has had focus, giving up
 * after 2n + 20 presses, and returns the stops it never reached (described)
 * that are still on the page. `trapped` (an open dialog): focus leaving
 * `root` fails at once.
 */
async function walk(page: Page, root: string, key: TabKey, trapped: boolean): Promise<string[]> {
	const stops = await liveStops(page, root);
	expect(stops.length, `tab stops in ${root}`).toBeGreaterThan(0);
	const all = new Set(stops);
	const reached = new Set<string>();
	const start = await focusAt(page, root);
	if (start.stop && all.has(start.stop)) reached.add(start.stop);
	for (let i = 0; i < 2 * stops.length + 20 && reached.size < all.size; i++) {
		await page.keyboard.press(key);
		const now = await focusAt(page, root);
		if (trapped && (now.body || !now.inside)) {
			const where = now.body ? "the page body" : await describe(page, "*:focus");
			throw new Error(`${key} took focus out of ${root} after ${i + 1} presses, to ${where}`);
		}
		if (now.stop && all.has(now.stop)) reached.add(now.stop);
	}
	const still = new Set(await liveStops(page, root));
	const missed = stops.filter((mark) => !reached.has(mark) && still.has(mark));
	return Promise.all(missed.map((mark) => describe(page, stopAt(mark))));
}

/** `<button> [settings-entry] "Label" 'Text'`: enough to find an element
 *  from a failure message. */
async function describe(page: Page, selector: string): Promise<string> {
	const found = await page.locator(selector).evaluateAll((els) =>
		els.map((el) => {
			const testid = el.getAttribute("data-testid");
			const label = el.getAttribute("aria-label");
			const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
			return [`<${el.tagName.toLowerCase()}>`, testid && `[${testid}]`, label && `"${label}"`, text && `'${text}'`]
				.filter(Boolean)
				.join(" ");
		}),
	);
	return found.join(", ") || "nothing";
}

/** The focused element's computed outline. */
async function outline(page: Page) {
	return page.evaluate(() => {
		const el = document.activeElement;
		if (!el || el === document.body) throw new Error("nothing has focus");
		const s = getComputedStyle(el);
		return { style: s.outlineStyle, width: s.outlineWidth, offset: s.outlineOffset, color: s.outlineColor };
	});
}

function modality(page: Page) {
	return page.evaluate(() => document.documentElement.dataset.inputModality ?? null);
}

/** The saved shortcut overrides (lh:keymap), or null when there are none. */
function keymap(page: Page) {
	return page.evaluate(() => {
		const raw = localStorage.getItem("lh:keymap");
		return raw === null ? null : (JSON.parse(raw) as unknown);
	});
}

/** The focused text field as "<chat field>#<mark>": the field it belongs to
 *  (CHAT_FIELDS) and a mark that tells two textareas apart. */
async function focusedField(page: Page): Promise<string> {
	return page.evaluate((fields) => {
		const el = document.activeElement;
		if (!(el instanceof HTMLTextAreaElement)) return `not a text field: <${el?.tagName.toLowerCase() ?? "none"}>`;
		const counter = window as Window & { e2eFields?: number };
		let mark = el.dataset.e2eField;
		if (mark === undefined) {
			counter.e2eFields = (counter.e2eFields ?? 0) + 1;
			mark = String(counter.e2eFields);
			el.dataset.e2eField = mark;
		}
		const field = el.closest(fields.map((f) => `[data-testid="${f}"]`).join(", "));
		return `${field?.getAttribute("data-testid") ?? "outside the chat fields"}#${mark}`;
	}, CHAT_FIELDS);
}
