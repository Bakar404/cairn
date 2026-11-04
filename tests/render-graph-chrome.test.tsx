/**
 * Empty-graph chrome pins (empty-graph chrome wave, owner 2026-09-25):
 * Import Notes renders ALWAYS — the one action that works on an empty
 * graph, the entry point itself; search + settings render only when the
 * snapshot has nodes (dead controls are lies — the honesty principle).
 * GraphChromeRow is the pure seam (the DeleteNodeBody pattern): SSR of
 * both states pins the ruling. Fetches don't run under renderToStaticMarkup
 * (effects never fire), so these pins exercise the component directly.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GraphChromeRow } from "../components/graph-view.tsx";
import type { GraphRenderSettings } from "../components/graph-canvas.ts";
import { CodeChangePanel, codeChangeRequestBody } from "../components/code-change-import.tsx";

/** Ref doubles — the SSR harness never attaches them. */
const ref = { current: null };

const PROPS = {
	query: "",
	onQuery: () => {},
	noMatch: false,
	importing: false,
	searchInputRef: ref,
	fileInputRef: ref,
	onImportFiles: () => {},
	codeChange: { importing: false, result: null, submit: () => {} },
	settings: {} as GraphRenderSettings,
	changeSettings: () => {},
	onOpenChains: () => {},
};

describe("GraphChromeRow — the empty-graph ruling (owner, 2026-09-25)", () => {
	it("EMPTY graph: Import Notes renders (the entry point), search + settings absent", () => {
		const html = renderToStaticMarkup(createElement(GraphChromeRow, { ...PROPS, isEmpty: true }));
		assert.ok(html.includes('data-testid="import-notes"'));
		assert.ok(html.includes("Import notes…"));
		assert.ok(html.includes('data-testid="import-change"'), "the code-change import is an entry point too (M22)");
		assert.ok(html.includes("Code change…"));
		assert.ok(!html.includes("Search nodes…"), "search is a lie on an empty graph");
		// the settings gear is the lucide-settings svg (tooltip wave: its old
		// native title is gone — the styled tooltip carries the label now)
		assert.ok(!html.includes("lucide-settings"), "settings is a lie on an empty graph");
		assert.ok(!html.includes('data-testid="open-chain-table"'), "chains is a lie on an empty graph");
		assert.ok(!html.includes("graph-chrome-fade-in"), "nothing gated = nothing fading in");
	});

	it("POPULATED graph: all four render, the gated trio carries the fade", () => {
		const html = renderToStaticMarkup(createElement(GraphChromeRow, { ...PROPS, isEmpty: false }));
		assert.ok(html.includes('data-testid="import-notes"'));
		assert.ok(html.includes('data-testid="import-change"'));
		assert.ok(html.includes("Search nodes…"));
		assert.ok(html.includes("lucide-settings"), "the settings gear renders");
		assert.ok(html.includes('data-testid="open-chain-table"'), "the chains entry renders");
		// the appear-once fade rides exactly the three gated controls, never Import Notes
		assert.equal(html.split("graph-chrome-fade-in").length - 1, 3, "three fade carriers: search + chains + settings");
	});

	it("the no-match note renders only when the wrapper says so (its truth stays upstream)", () => {
		const html = renderToStaticMarkup(
			createElement(GraphChromeRow, { ...PROPS, isEmpty: false, query: "zzz", noMatch: true }),
		);
		assert.ok(html.includes("No matching nodes."));
		const quiet = renderToStaticMarkup(
			createElement(GraphChromeRow, { ...PROPS, isEmpty: false, query: "zzz", noMatch: false }),
		);
		assert.ok(!quiet.includes("No matching nodes."));
	});
});

describe("the code-change import panel (M22)", () => {
	const EMPTY = { url: "", repoPath: "", range: "" };
	const panel = (props: Partial<Parameters<typeof CodeChangePanel>[0]>) =>
		renderToStaticMarkup(createElement(CodeChangePanel, {
			kind: "pr", onKind: () => {}, fields: EMPTY, onFields: () => {},
			importing: false, result: null, onSubmit: () => {}, ...props,
		}));
	const submitTag = (html: string) => /<button[^>]*data-testid="import-change-submit"[^>]*>/.exec(html)?.[0] ?? "";

	it("asks for the chosen kind's fields, and Import waits until the one it needs is filled", () => {
		const pr = panel({});
		assert.ok(pr.includes('role="dialog"') && pr.includes('aria-label="Import a code change"'));
		assert.match(pr, /aria-pressed="true"[^>]*>Pull request</);
		assert.ok(pr.includes("Pull request link"));
		assert.ok(submitTag(pr).includes('disabled=""'));
		const git = panel({ kind: "git", fields: { ...EMPTY, repoPath: "C:\\code\\repo" } });
		assert.match(git, /aria-pressed="true"[^>]*>Local commits</);
		assert.ok(git.includes("Repository folder") && git.includes("aria-describedby="));
		assert.ok(!submitTag(git).includes('disabled=""'));
		assert.deepEqual(
			codeChangeRequestBody("git", { url: "o/r#1", repoPath: " /r ", range: " HEAD~1..HEAD " }),
			{ kind: "git", repoPath: "/r", range: "HEAD~1..HEAD" },
		);
	});

	it("reports what came in and what was left out, or why the import failed", () => {
		const done = panel({
			result: { ok: true, filePath: "github.com/o/r/pull/12", files: ["a.ts"], skipped: ["yarn.lock"], omitted: [], stats: { nodes: 2 } },
		});
		assert.ok(done.includes("Imported github.com/o/r/pull/12: 2 new propositions from 1 file, 1 file left out."));
		assert.ok(done.includes('role="status"'));
		const failed = panel({
			result: { ok: false, error: "No models are set up.", code: "models_not_configured", missing: ["cheap", "strong"] },
		});
		assert.ok(failed.includes('role="alert"'));
		assert.ok(failed.includes("No models are set up.\nmodels_not_configured — cheap, strong"));
		const busy = panel({ importing: true });
		assert.ok(busy.includes("Importing…") && busy.includes("This can take a few minutes."));
		assert.ok(submitTag(busy).includes('disabled=""'));
	});
});