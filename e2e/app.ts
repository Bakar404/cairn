/**
 * What the specs share: their `test`, the golden fixtures' chats and the
 * waits that say a page is ready.
 */
import { test as base, expect, type Locator, type Page } from "@playwright/test";

export { expect };

export type Mode = "dark" | "light";
export type Transparency = "no-preference" | "reduce";

/** Every spec's `test`. Playwright answers the OS media queries itself
 *  (contrast, forced colors, motion: no preference unless a test asks), so
 *  a run doesn't depend on the machine's settings. It can't answer
 *  prefers-reduced-transparency yet, and Follow system would turn every
 *  translucent surface solid wherever the host asks (Windows with
 *  transparency effects off, macOS with Reduce transparency on). This
 *  answers it through Chromium's DevTools protocol before each page loads;
 *  `transparency` changes the answer mid-test. Playwright's own media
 *  overrides live in another session, so neither clears the other's. */
export const test = base.extend<{ transparency: (value: Transparency) => Promise<void> }>({
	transparency: [
		async ({ page }, use) => {
			const cdp = await page.context().newCDPSession(page);
			const emulate = async (value: Transparency) => {
				await cdp.send("Emulation.setEmulatedMedia", {
					features: [{ name: "prefers-reduced-transparency", value }],
				});
			};
			await emulate("no-preference");
			await use(emulate);
		},
		{ auto: true },
	],
});

export const PRACTICE_CHAT = "chat_mv293wv5_10656952";
export const LESSON_CHAT = "chat_mv27rrra_feff23b6";

/** Once the app has hydrated and loaded its settings, the appearance
 *  provider stores the mode (src/core/theme-mode.ts) and applies it to
 *  <html>, and the accessibility provider caches its section
 *  (src/core/accessibility.ts) after applying it. */
export async function hydrated(page: Page, mode: Mode) {
	await page.waitForFunction(
		(mode) =>
			localStorage.getItem("cairn-mode") === mode &&
			localStorage.getItem("cairn-a11y") !== null &&
			document.documentElement.classList.contains("dark") === (mode === "dark"),
		mode,
		{ timeout: 30_000 },
	);
}

export async function homeReady(page: Page) {
	await expect(page.getByTestId("home-mode-switch")).toBeVisible();
}

export async function composerReady(page: Page) {
	await expect(page.getByTestId("composer")).toBeVisible();
}

export async function chatReady(page: Page) {
	await composerReady(page);
	await expect(page.getByRole("log").getByTestId("user-message").first()).toBeVisible();
}

/** Puts the accessibility section back to the defaults. */
export async function resetAccessibility(page: Page) {
	const res = await page.request.put("/api/settings/accessibility", { data: {} });
	expect(res.ok(), `PUT /api/settings/accessibility: ${res.status()}`).toBe(true);
}

/** Opens the shut disclosures under `scope` (a button with
 *  aria-expanded="false" that names the region it controls; menu buttons,
 *  with aria-haspopup, stay shut), so a scan or a tab walk reaches what
 *  they hide. Returns how many it opened. */
export async function openDisclosures(scope: Locator): Promise<number> {
	const regions = await scope
		.locator('button[aria-expanded="false"][aria-controls]:not([aria-haspopup])')
		.evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-controls") ?? ""));
	for (const region of regions) {
		const toggle = scope.locator(`button[aria-controls="${region}"]`);
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-expanded", "true");
		await expect(scope.page().locator(`[id="${region.split(/\s+/)[0]}"]`)).toBeVisible();
	}
	return regions.length;
}

/** Runs `body` with the appearance section patched, as saved settings: the
 *  patch is written, the page reloads and hydrates in `mode`, and the
 *  original section is written back afterwards (the page keeps the patch
 *  until it next loads). */
export async function withAppearance(
	page: Page,
	patch: Record<string, unknown>,
	mode: Mode,
	body: () => Promise<void>,
) {
	const res = await page.request.get("/api/settings");
	expect(res.ok()).toBe(true);
	const { settings } = (await res.json()) as { settings?: { appearance?: Record<string, unknown> } | null };
	const original = settings?.appearance ?? {};
	await putAppearance(page, { ...original, ...patch });
	try {
		await page.reload();
		await hydrated(page, mode);
		await body();
	} finally {
		await putAppearance(page, original);
	}
}

async function putAppearance(page: Page, appearance: Record<string, unknown>) {
	const res = await page.request.put("/api/settings/appearance", { data: appearance });
	expect(res.ok(), `PUT /api/settings/appearance: ${res.status()}`).toBe(true);
}

/** True once the DOM has gone `ms` without a change, false at the first
 *  change. */
export function domQuiet(page: Page, ms: number): Promise<boolean> {
	return page.evaluate(
		(ms) =>
			new Promise<boolean>((resolve) => {
				const observer = new MutationObserver(() => {
					observer.disconnect();
					clearTimeout(timer);
					resolve(false);
				});
				const timer = setTimeout(() => {
					observer.disconnect();
					resolve(true);
				}, ms);
				observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
			}),
		ms,
	);
}

/** Waits (3 s at most) for the finite CSS animations and transitions to
 *  end: an entrance still fading in would be measured mid-fade. */
export async function animationsDone(page: Page) {
	await page.evaluate(async () => {
		const finite = document.getAnimations().filter((a) => {
			const end = a.effect?.getComputedTiming().endTime;
			return typeof end === "number" && Number.isFinite(end);
		});
		await Promise.race([
			Promise.all(finite.map((a) => a.finished.catch(() => undefined))),
			new Promise((resolve) => setTimeout(resolve, 3000)),
		]);
	});
}

/** `color` (a variable or a system color) as the browser computes it, to
 *  compare with a computed color. */
export async function computedColor(page: Page, color: string) {
	return page.evaluate((color) => {
		const probe = document.createElement("span");
		probe.style.color = color;
		// Forced colors would repaint the probe itself.
		probe.style.setProperty("forced-color-adjust", "none");
		document.body.append(probe);
		const value = getComputedStyle(probe).color;
		probe.remove();
		return value;
	}, color);
}
