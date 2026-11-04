/**
 * a11y.spec.ts — the axe checks (playwright.config.ts runs them against the
 * standalone build on the golden fixtures).
 *
 * Every page is scanned with axe-core's WCAG 2.0/2.1/2.2 A and AA rules and
 * compared with a11y-baseline.json, keyed "<page>|<project>|<mode>". A rule
 * that is new on a page, or that hits more nodes than its baseline count,
 * fails. A count that drops prints a notice: lower the baseline so it can't
 * creep back. UPDATE_A11Y_BASELINE=1 rewrites the scanned keys with the
 * current counts.
 *
 * Every project scans in dark mode (the factory default); the default
 * project also scans in light mode. Settings sections are read from the
 * dialog's nav, so a new section is scanned without touching this file,
 * and each is scanned with its disclosures open.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import type { Page, Request } from "@playwright/test";
import {
	animationsDone,
	chatReady,
	composerReady,
	domQuiet,
	expect,
	homeReady,
	hydrated,
	LESSON_CHAT,
	openDisclosures,
	PRACTICE_CHAT,
	test as base,
	type Mode,
	withAppearance,
} from "./app.ts";

type Counts = Record<string, number>;
type Violation = Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"][number];
type Scan = { page: Page; settle: () => Promise<void>; key: string; project: string; scope?: string };

const BASELINE_FILE = path.join(import.meta.dirname, "a11y-baseline.json");
const UPDATE = process.env.UPDATE_A11Y_BASELINE === "1";
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const NODES_SHOWN = 5;
/** Connections that stay open by design, like the app's /api/events stream. */
const STREAMS = new Set(["eventsource", "websocket"]);
const SETTLE_CAP_MS = 15_000;

/** `settle` waits until no request is in flight, the DOM has been quiet for
 *  500 ms and the finite CSS animations and transitions have ended, so the
 *  counts don't depend on timing. */
const test = base.extend<{ settle: () => Promise<void> }>({
	settle: async ({ page }, use) => {
		const pending = new Set<Request>();
		page.on("request", (r) => {
			if (!STREAMS.has(r.resourceType())) pending.add(r);
		});
		const done = (r: Request) => void pending.delete(r);
		page.on("requestfinished", done);
		page.on("requestfailed", done);
		await use(async () => {
			const deadline = Date.now() + SETTLE_CAP_MS;
			let settled = false;
			while (!settled && Date.now() < deadline) {
				if (pending.size > 0) await new Promise((resolve) => setTimeout(resolve, 100));
				else settled = (await domQuiet(page, 500)) && pending.size === 0;
			}
			if (!settled) {
				const open = [...pending].map((r) => r.url());
				console.warn(`[a11y] ${page.url()} didn't settle in ${SETTLE_CAP_MS} ms; in flight: ${open.join(", ") || "none"}`);
			}
			await animationsDone(page);
		});
	},
});

const PAGES = [
	{ name: "home", url: "/", ready: homeReady },
	{ name: "new-session", url: "/chat/new", ready: composerReady },
	{ name: "practice", url: `/chat/${PRACTICE_CHAT}`, ready: chatReady },
	{ name: "lesson", url: `/chat/${LESSON_CHAT}`, ready: chatReady },
];

for (const { name, url, ready } of PAGES) {
	test(name, async ({ page, settle }, testInfo) => {
		const project = testInfo.project.name;
		await page.goto(url);
		await hydrated(page, "dark");
		await ready(page);
		await test.step("dark", () => check({ page, settle, project, key: `${name}|${project}|dark` }));
		if (project !== "default") return;
		await test.step("light", () =>
			inLight(page, async () => {
				await ready(page);
				await check({ page, settle, project, key: `${name}|${project}|light` });
			}),
		);
	});
}

test("settings", async ({ page, settle }, testInfo) => {
	test.slow();
	const project = testInfo.project.name;
	await page.goto("/");
	await hydrated(page, "dark");
	await homeReady(page);
	await scanSettings(page, settle, project, "dark");
	if (project !== "default") return;
	await inLight(page, async () => {
		await homeReady(page);
		await scanSettings(page, settle, project, "light");
	});
});

async function scanSettings(page: Page, settle: () => Promise<void>, project: string, mode: Mode) {
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
			await check({
				page,
				settle,
				project,
				key: `settings-${id}|${project}|${mode}`,
				scope: '[data-testid="settings-dialog"]',
			});
		});
	}
}

/** Runs `scan` with the app in light mode. The saved setting decides the
 *  mode once the app loads, so this saves it and reloads. */
function inLight(page: Page, scan: () => Promise<void>) {
	return withAppearance(page, { mode: "light" }, "light", scan);
}

async function check({ page, settle, key, project, scope }: Scan) {
	await settle();
	const axe = new AxeBuilder({ page }).withTags(TAGS);
	if (scope) axe.include(scope);
	// Under forced colors the browser paints the user's theme colors, but axe
	// measures the page's own: it reported #9aa6b5 on white for text that
	// renders black. Contrast there belongs to the theme, so the rule is off.
	if (project === "forced-colors") axe.disableRules(["color-contrast"]);
	const { violations } = await axe.analyze();
	const counts: Counts = Object.fromEntries(violations.map((v) => [v.id, v.nodes.length]));

	if (UPDATE) {
		writeBaseline(key, counts);
		return;
	}
	const allowed = readBaseline()[key] ?? {};
	for (const [rule, was] of Object.entries(allowed)) {
		const now = counts[rule] ?? 0;
		if (now < was) {
			console.log(`[a11y] ${key}: ${rule} is down to ${now} from ${was}. Lower the baseline: UPDATE_A11Y_BASELINE=1.`);
		}
	}
	const over = violations.filter((v) => v.nodes.length > (allowed[v.id] ?? 0));
	expect.soft(over.map((v) => explain(v, allowed[v.id] ?? 0)), `axe violations above the baseline on ${key}`).toEqual([]);
}

function explain(v: Violation, allowed: number): string {
	const lines = [
		`${v.id} (${v.impact ?? "no impact"}): ${v.nodes.length} node(s), baseline ${allowed}. ${v.help}`,
		`  ${v.helpUrl}`,
	];
	for (const node of v.nodes.slice(0, NODES_SHOWN)) {
		lines.push(`  - ${node.target.join(" ")}`);
		if (node.failureSummary) lines.push(...node.failureSummary.split("\n").map((l) => `      ${l}`));
	}
	if (v.nodes.length > NODES_SHOWN) lines.push(`  …and ${v.nodes.length - NODES_SHOWN} more`);
	return lines.join("\n");
}

function readBaseline(): Record<string, Counts> {
	try {
		return JSON.parse(fs.readFileSync(BASELINE_FILE, "utf-8")) as Record<string, Counts>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

/** Read-modify-write, keys and rules sorted so diffs stay small. Safe
 *  because the config runs one worker. */
function writeBaseline(key: string, counts: Counts) {
	const all = { ...readBaseline(), [key]: counts };
	const sorted = Object.fromEntries(
		Object.keys(all)
			.sort()
			.map((k) => [k, Object.fromEntries(Object.entries(all[k] ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)))]),
	);
	fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(sorted, null, 2)}\n`, "utf-8");
}
