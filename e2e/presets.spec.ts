/**
 * presets.spec.ts — the accessibility presets (M27), against the same
 * build and fixtures as the axe checks.
 *
 * - A preset is a switch: on writes its values, and off returns them to
 *   their defaults, the text size it sets in Appearance included.
 * - Reset sits outside Advanced, so it's there with Advanced shut, and it
 *   turns every preset off, the text size and graph view they set on other
 *   pages included.
 *
 * The browser has no desktop zoom; the unit tests cover Low vision's.
 */
import type { Locator, Page } from "@playwright/test";
import { expect, homeReady, hydrated, resetAccessibility, test } from "./app.ts";

type Section = Record<string, unknown>;
type Sections = { accessibility?: Section; appearance?: Section; graph?: Section };

test("a preset is a switch: on writes its values, off returns them to the defaults", async ({ page }) => {
	await openHome(page);
	const html = page.locator("html");
	const original = await stored(page);
	try {
		const section = await openAccessibility(page);
		const lowVision = section.getByTestId("preset-low-vision");
		await expect(lowVision).toHaveAccessibleName("Low vision");
		await expect(lowVision).toHaveAttribute("aria-checked", "false");

		await saved(page, () => lowVision.click());
		await expect(lowVision, "on").toHaveAttribute("aria-checked", "true");
		await expect(html).toHaveAttribute("data-contrast", "high");
		await expect(html).toHaveAttribute("data-focus", "enhanced");
		await expect.poll(() => proseSize(page), { message: "the text size" }).toBe("20px");

		await saved(page, () => lowVision.click());
		await expect(lowVision, "off").toHaveAttribute("aria-checked", "false");
		await expect(lowVision, "the switch keeps focus").toBeFocused();
		await expect(html).toHaveAttribute("data-contrast", "standard");
		await expect(html).toHaveAttribute("data-focus", "standard");
		await expect.poll(() => proseSize(page), { message: "the text size" }).toBe("16px");
		const after = await stored(page);
		expect(after.accessibility ?? {}, "Accessibility is back where it was").toEqual(original.accessibility ?? {});
		expect(after.appearance ?? {}, "and so is Appearance").toEqual(original.appearance ?? {});
	} finally {
		await restore(page, original);
	}
});

test("Reset is there with Advanced shut, and turns every preset off on every page they write", async ({ page }) => {
	await openHome(page);
	const original = await stored(page);
	try {
		const section = await openAccessibility(page);
		for (const id of ["low-vision", "screen-reader"]) {
			const preset = section.getByTestId(`preset-${id}`);
			await saved(page, () => preset.click());
			await expect(preset, id).toHaveAttribute("aria-checked", "true");
		}
		await expect(section.getByTestId("a11y-advanced-toggle")).toHaveAttribute("aria-expanded", "false");
		const reset = section.getByTestId("a11y-reset");
		await expect(reset).toBeVisible();

		await saved(page, () => reset.click());
		await expect(reset, "Reset keeps focus").toBeFocused();
		for (const id of ["low-vision", "reading-comfort", "reduce-motion", "screen-reader"]) {
			await expect(section.getByTestId(`preset-${id}`), id).toHaveAttribute("aria-checked", "false");
		}
		const after = await stored(page);
		expect(after.accessibility, "Accessibility is cleared").toEqual({});
		expect(after.appearance?.proseFontSize, "Low vision's text size is undone").toBeUndefined();
		expect(after.graph?.rendering, "Screen reader's graph view is undone").toBeUndefined();
	} finally {
		await restore(page, original);
	}
});

async function openHome(page: Page) {
	await page.goto("/");
	await hydrated(page, "dark");
	await homeReady(page);
}

/** Opens Settings → Accessibility, with Advanced shut as it starts. */
async function openAccessibility(page: Page): Promise<Locator> {
	await page.getByTestId("settings-entry").click();
	const dialog = page.getByTestId("settings-dialog");
	await expect(dialog.getByText("Loading settings…")).toHaveCount(0);
	await dialog.getByTestId("settings-nav-accessibility").click();
	const section = dialog.getByTestId("section-accessibility");
	await expect(section).toBeVisible();
	return section;
}

/** Runs `act` and waits for the accessibility section's PUT it causes,
 *  the last of a preset's writes. */
async function saved(page: Page, act: () => Promise<void>) {
	const put = page.waitForResponse(
		(r) => r.url().endsWith("/api/settings/accessibility") && r.request().method() === "PUT",
	);
	await act();
	expect((await put).ok(), "PUT /api/settings/accessibility").toBe(true);
}

/** The sections the presets write, as stored. */
async function stored(page: Page): Promise<Sections> {
	const res = await page.request.get("/api/settings");
	expect(res.ok(), `GET /api/settings: ${res.status()}`).toBe(true);
	const { settings } = (await res.json()) as { settings?: Sections | null };
	return settings ?? {};
}

/** Puts back the sections the presets write. */
async function restore(page: Page, original: Sections) {
	await resetAccessibility(page);
	for (const name of ["appearance", "graph"] as const) {
		const res = await page.request.put(`/api/settings/${name}`, { data: original[name] ?? {} });
		expect(res.ok(), `PUT /api/settings/${name}: ${res.status()}`).toBe(true);
	}
}

/** The reading text size the appearance provider sets on <html>. */
function proseSize(page: Page): Promise<string> {
	return page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--lh-prose-size").trim());
}
