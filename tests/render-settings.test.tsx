/**
 * Settings-surface render tests (thin settings wave): SSR of the section
 * components pins the THIN markup — toggle rows, the graph ladder's
 * graying, the mode control's honest disabled state, the role rows and
 * tool rows. Fetches don't run under renderToStaticMarkup (effects never
 * fire), so the SSR state IS the loading state — asserted as such.
 * Same tsx classic-JSX shim as render-sidebar.test.tsx.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TOGGLE_TOOLS, AgentSection } from "../components/settings/agent-section.tsx";
import { AppearanceSection, GraphSection } from "../components/settings/appearance-section.tsx";
import { AccessibilitySection } from "../components/settings/accessibility-section.tsx";
import { KeysSection } from "../components/settings/keys-section.tsx";
import { KeyboardSection } from "../components/settings/keyboard-section.tsx";
import type { AccessibilitySettings, AppearanceSettings, GraphSettings } from "../src/core/index.ts";
import { SettingsDialogBody, SettingsDialogProvider } from "../components/settings/settings-dialog.tsx";
import { KEYBOARD_ACTIONS } from "../src/core/index.ts";

/** The full opening tag of the element carrying a testid — attribute
 *  order in React output is not contractual, so assertions run on the
 *  whole tag instead of ordered regex chains. */
function tagOf(html: string, testid: string): string {
	const i = html.indexOf(`data-testid="${testid}"`);
	assert.ok(i >= 0, `missing ${testid}`);
	return html.slice(html.lastIndexOf("<", i), html.indexOf(">", i) + 1);
}

/** The markup of the <div> that opens at `start`, through its matching
 *  close. */
function divAt(html: string, start: number): string {
	const tag = /<div[\s>]|<\/div>/g;
	tag.lastIndex = start;
	let depth = 0;
	for (let m = tag.exec(html); m; m = tag.exec(html)) {
		depth += m[0] === "</div>" ? -1 : 1;
		if (depth === 0) return html.slice(start, m.index + m[0].length);
	}
	assert.fail(`no </div> closes the div at ${start}`);
}

describe("SettingsDialog (the designed surface, SSR)", () => {
	it("provider CLOSED: children only — no dialog, no portal content", () => {
		const html = renderToStaticMarkup(
			<SettingsDialogProvider>
				<p>the app</p>
			</SettingsDialogProvider>,
		);
		assert.ok(html.includes("the app"));
		assert.ok(!html.includes("settings-backdrop"));
		assert.ok(!html.includes("settings-dialog"));
	});

	it("the dialog frame: role=dialog + the ✕ + the eight-section nav, Providers first and General last", () => {
		const html = renderToStaticMarkup(<SettingsDialogBody onClose={() => {}} />);
		assert.ok(html.includes('role="dialog"'));
		assert.ok(html.includes('aria-modal="true"'));
		assert.ok(html.includes('aria-label="Close settings"'));
		for (const id of ["general", "keys", "agent", "appearance", "accessibility", "graph", "keyboard", "storage"]) {
			assert.ok(html.includes(`data-testid="settings-nav-${id}"`), id);
		}
		// Providers is the first landing section; internal keys deep links survive.
		assert.ok(tagOf(html, "settings-nav-keys").includes('aria-current="true"'));
		assert.ok(html.indexOf('data-testid="settings-nav-keys"') < html.indexOf('data-testid="settings-nav-general"'));
		assert.ok(tagOf(html, "settings-nav-keyboard").includes('aria-current="false"'));
		// Fetches don't run under SSR — the loading state IS the SSR state.
		assert.ok(html.includes("Loading settings…"));
		// Modal-only doctrine: no link back to /settings anywhere in it.
		assert.ok(!html.includes('href="/settings"'));
	});
});

describe("AgentSection (thin SSR)", () => {
	it("renders the three model SLOT rows (slots-only, fix wave: unpicked reads —, no Default option)", () => {
		const html = renderToStaticMarkup(<AgentSection agent={undefined} models={undefined} graph={undefined} onSectionChange={() => {}} onModelsChange={() => {}} />);
		for (const slot of ["strong", "cheap", "vision"]) {
			assert.ok(html.includes(`data-testid="slot-row-${slot}"`), slot);
			// The shared model-picker dropdown as the opened menu (owner,
			// 2026-09-20), the thin trigger as the collapsed look.
			assert.ok(html.includes(`data-testid="slot-model-${slot}"`), `${slot} model trigger`);
			assert.ok(html.includes(`data-testid="slot-thinking-${slot}"`), `${slot} thinking trigger`);
			// the roster hint rides every row
			assert.ok(html.includes("The main model for your sessions") || slot !== "strong", "strong roster");
		}
		// Fix wave: no Default anywhere — an unpicked slot reads "—"
		// (the owner's no-factory-fallback language), and no menu
		// carries a Default row (menu-default testid is retired).
		assert.equal((html.match(/>Default<\/span>/g) ?? []).length, 0, "no Default trigger");
		assert.ok(!html.includes('data-testid="menu-default"'), "no Default row");
		assert.equal((html.match(/>—<\/span>/g) ?? []).length, 6, "three slots × two — triggers");
		// the per-role rows are GONE (slots-only)
		for (const role of ["researcher", "demoBuilder", "visualMaker"]) {
			assert.ok(!html.includes(`data-testid="role-row-${role}"`), `${role} retired`);
		}
		assert.ok(html.includes('data-testid="group-models"'), "Models sub-group");
		assert.ok(html.includes('data-testid="group-tools"'), "Tools sub-group");
		assert.ok(html.includes('data-testid="group-prompts"'), "System prompts sub-group");
		// web search runs on GitHub Copilot only — the engine row is retired (2026-10-27)
		assert.ok(!html.includes('data-testid="search-engine-row"'), "no search-engine row");
	});

	it("the prober graph-tools row: FIRST in the Tools group, default ON, its own key (wave 7)", () => {
		// Default state: graph on, graphTools absent → ON, the describing
		// hint rides.
		const html = renderToStaticMarkup(<AgentSection agent={undefined} models={undefined} graph={undefined} onSectionChange={() => {}} onModelsChange={() => {}} />);
		const toolsGroup = html.split('data-testid="group-tools"')[1] ?? "";
		const rows = [...toolsGroup.matchAll(/data-testid="(graph-tools-row|tool-row-\w+)"/g)].map((m) => m[1]);
		assert.equal(rows[0], "graph-tools-row", "graph tools is the FIRST row of the Tools group");
		// (the apostrophe in "sessions'" HTML-escapes — match up to it)
		assert.ok(html.includes("Lets the tutor consult your knowledge map between sessions"), "the describing hint");
		assert.ok((html.split('data-testid="graph-tools-row"')[1] ?? "").includes('aria-checked="true"'), "absent = on");
		const rowHtml = html.split('data-testid="graph-tools-row"')[1]?.split('data-testid="tool-row-')[0] ?? "";
		assert.ok(!rowHtml.includes("opacity-40"), "lit while the graph is on");
	});

	it("graph disabled dims the graph-tools row with the honest hint (the predicate composes)", () => {
		const html = renderToStaticMarkup(
			<AgentSection agent={undefined} models={undefined} graph={{ enabled: false }} onSectionChange={() => {}} onModelsChange={() => {}} />,
		);
		const row = html.split('data-testid="graph-tools-row"')[1]?.split('data-testid="tool-row-')[0] ?? "";
		assert.match(row, /opacity-40"><button[^>]*role="switch"/, "the toggle dims when the graph is off");
		assert.ok(!row.slice(0, row.indexOf(">")).includes("opacity"), "the row's text never fades (axe contrast)");
		assert.match(row, /text-\(length:--lh-prose-size\) text-muted-foreground">Graph tools</, "the label mutes instead, at its size");
		assert.ok(row.includes("Graph is disabled"), "the reason hint replaces the description");
		assert.ok(row.includes("disabled"), "toggle untouchable while the graph is off");
	});

	it("an explicit graphTools off shows stored-off (the record never lies)", () => {
		const html = renderToStaticMarkup(
			<AgentSection agent={{ graphTools: { enabled: false } }} models={undefined} graph={undefined} onSectionChange={() => {}} onModelsChange={() => {}} />,
		);
		const row = html.split('data-testid="graph-tools-row"')[1] ?? "";
		assert.ok(row.includes('aria-checked="false"'), "stored-off renders off");
	});

	it("renders the owner's FINAL tool list — research, demo, visual, pdf, animation", () => {
		assert.deepEqual([...TOGGLE_TOOLS], ["research", "demo", "visual", "pdf", "animation"]);
		const html = renderToStaticMarkup(<AgentSection agent={undefined} models={undefined} graph={undefined} onSectionChange={() => {}} onModelsChange={() => {}} />);
		for (const id of TOGGLE_TOOLS) assert.ok(html.includes(`data-testid="tool-row-${id}"`), id);
	});

	it("tools default ON (absent key = enabled)", () => {
		const html = renderToStaticMarkup(<AgentSection agent={undefined} models={undefined} graph={undefined} onSectionChange={() => {}} onModelsChange={() => {}} />);
		for (const id of TOGGLE_TOOLS) {
			assert.ok(tagOf(html, `toggle-tool-${id}`).includes('aria-checked="true"'), `${id} defaults on`);
		}
	});

	it("an overridden SLOT shows its model in the trigger, tools carry the delta", () => {
		const html = renderToStaticMarkup(
			<AgentSection
				agent={{ tools: { demo: false } }}
				models={{ strong: { model: { provider: "zai", id: "glm-4.7-flash" } } }}
				onSectionChange={() => {}}
				onModelsChange={() => {}}
			/>,
		);
		// The trigger shows the stored id even with no catalog loaded (a
		// trigger reading "Default" over a live override would lie).
		assert.ok(html.includes("glm-4.7-flash"), "the override id is visible (prettyModel form, no auto-caps)");
		assert.ok(tagOf(html, "toggle-tool-demo").includes('aria-checked="false"'), "demo off");
		assert.ok(tagOf(html, "toggle-tool-visual").includes('aria-checked="true"'), "visual still on");
	});

	it("prompts show the loading state under SSR (effects never fire)", () => {
		const html = renderToStaticMarkup(<AgentSection agent={undefined} models={undefined} graph={undefined} onSectionChange={() => {}} onModelsChange={() => {}} />);
		assert.ok(html.includes("Loading prompt segments"));
	});
});

describe("GraphSection — master switch + chunk budget (wave 7 + 2026-10-02)", () => {
	// Wave 7 (owner ruling 2026-09-23): the section is the master switch —
	// the embedding/clustering/labeling rungs and the BYOK model picker are
	// gone (clustering is the free birth-session partition, labels ARE
	// session names). The chunk budget (2026-10-02) joined as the second and
	// only other control — it denominates the coverage ring and gates the
	// auto-extraction trigger, resolved through the same core resolver the
	// server uses (the 4096-fallback fix).
	it("renders the master-switch row — EXTRACTION since 2026-10-06 (the data channel, renamed when rendering split off)", () => {
		const html = renderToStaticMarkup(<GraphSection graph={undefined} onSectionChange={() => {}} />);
		assert.ok(html.includes('data-testid="graph-row-enabled"'));
		assert.ok(html.includes(">Extraction<"), "the row names the DATA channel, not 'Graph'");
		assert.ok(!html.includes("graph-row-embedding"), "the dead rungs render nothing");
		assert.ok(!html.includes("Embedding model"), "the picker is gone");
		assert.ok(!html.includes("graph-row-clustering"));
		assert.ok(!html.includes("graph-row-labeling"));
		assert.ok(tagOf(html, "toggle-extraction-enabled").includes('aria-checked="true"'), "absent record = factory ON");
	});

	it("a stored off record shows the extraction switch off", () => {
		const html = renderToStaticMarkup(<GraphSection graph={{ enabled: false }} onSectionChange={() => {}} />);
		assert.ok(tagOf(html, "toggle-extraction-enabled").includes('aria-checked="false"'));
	});

	it("the GRAPH RENDERING row (2026-10-06): display-only — absent record = factory ON, stored off shows off", () => {
		const html = renderToStaticMarkup(<GraphSection graph={undefined} onSectionChange={() => {}} />);
		assert.ok(html.includes('data-testid="graph-row-rendering"'));
		assert.ok(html.includes(">Graph rendering<"));
		assert.ok(tagOf(html, "toggle-graph-rendering-enabled").includes('aria-checked="true"'), "the home defaults to the canvas");
		const off = renderToStaticMarkup(<GraphSection graph={{ rendering: false }} onSectionChange={() => {}} />);
		assert.ok(tagOf(html, "toggle-extraction-enabled").includes('aria-checked="true"'), "rendering off does NOT touch extraction");
		assert.ok(tagOf(off, "toggle-graph-rendering-enabled").includes('aria-checked="false"'));
	});

	it("the chunk-budget row: unset shows EMPTY with the factory placeholder + hint — one truth with the trigger", () => {
		const html = renderToStaticMarkup(<GraphSection graph={undefined} onSectionChange={() => {}} />);
		const input = tagOf(html, "input-chunk-tokens");
		assert.ok(input.includes('placeholder="4096"'), "the placeholder IS the resolved factory default");
		assert.ok(!/value="\d/.test(input), "unset renders EMPTY, not a materialized 4096");
		assert.ok(html.includes(">4096 tok</"), "the hint reports the resolved truth");
	});

	it("a stored budget shows its value and denominates the hint", () => {
		const html = renderToStaticMarkup(
			<GraphSection graph={{ enabled: true, extractionChunkTokens: 6000 }} onSectionChange={() => {}} />,
		);
		assert.ok(tagOf(html, "input-chunk-tokens").includes('value="6000"'));
		assert.ok(html.includes(">6000 tok</"));
	});
});

describe("KeysSection (thin SSR)", () => {
	it("SSR = the loading state (effects never fire)", () => {
		const html = renderToStaticMarkup(<KeysSection />);
		assert.ok(html.includes("Loading keys…"));
	});
});

describe("AppearanceSection (thin SSR)", () => {
	it("mode offers Dark / Light / System, live", () => {
		const html = renderToStaticMarkup(<AppearanceSection appearance={undefined} onSectionChange={() => {}} />);
		const select = tagOf(html, "select-mode");
		assert.ok(!select.includes("disabled"), "mode select is enabled");
		for (const v of ["dark", "light", "system"]) assert.ok(html.includes(`<option value="${v}"`), v);
		assert.ok(!html.includes("Coming soon"));
		const modeRow = html.split('data-testid="row-mode"')[1]?.split('data-testid="row-')[0] ?? "";
		assert.ok(modeRow && !modeRow.includes("opacity-40"), "the row no longer dims");
	});

	it("hex inputs carry the factory placeholders; prose size resolves against the factory", () => {
		const html = renderToStaticMarkup(<AppearanceSection appearance={undefined} onSectionChange={() => {}} />);
		assert.ok(html.includes(`placeholder="#0c121d"`), "the dark factory background (SSR scheme)");
		// The reading font is the searchable dropdown now (font-menu
		// wave): its trigger shows the factory family; the emphasis
		// inks' empty state is "same as text" (the old hexes died with
		// the factory token change).
		assert.ok(html.includes('data-testid="font-trigger"'));
		assert.equal((html.match(/Empty = same as text/g) ?? []).length, 2);
		assert.ok(html.includes("16px"));
	});

	it("a set background shows in the input, not the placeholder", () => {
		const html = renderToStaticMarkup(
			<AppearanceSection appearance={{ background: "#1a1a2e" }} onSectionChange={() => {}} />,
		);
		assert.ok(html.includes(`value="#1a1a2e"`));
	});
});

describe("AccessibilitySection (thin SSR)", () => {
	const render = (
		accessibility: AccessibilitySettings | undefined,
		{ appearance, graph }: { appearance?: AppearanceSettings; graph?: GraphSettings } = {},
	) =>
		renderToStaticMarkup(
			<AccessibilitySection
				accessibility={accessibility}
				appearance={appearance}
				graph={graph}
				onSectionChange={() => {}}
				onAppearanceChange={() => {}}
				onGraphChange={() => {}}
			/>,
		);

	/** The selected option of one select, found by its testid. */
	const selected = (accessibility: AccessibilitySettings | undefined, testid: string) => {
		const html = render(accessibility);
		const start = html.indexOf(`data-testid="${testid}"`);
		assert.ok(start >= 0, `missing ${testid}`);
		return html.slice(start, html.indexOf("</select>", start)).match(/<option value="(\w+)" selected="">/)?.[1];
	};

	it("contrast shows the stored choice, and Standard when none is stored", () => {
		assert.equal(selected(undefined, "select-contrast"), "standard");
		assert.equal(selected({ contrast: "high" }, "select-contrast"), "high");
	});

	it("the focus indicator shows the stored choice, and Standard when none is stored", () => {
		assert.equal(selected(undefined, "select-focus"), "standard");
		assert.equal(selected({ focus: "enhanced" }, "select-focus"), "enhanced");
	});

	it("motion shows the stored choice, and System when none is stored", () => {
		assert.equal(selected(undefined, "select-motion"), "system");
		assert.equal(selected({ motion: "reduced" }, "select-motion"), "reduced");
		assert.equal(selected({ motion: "full" }, "select-motion"), "full");
	});

	it("Follow system is on unless turned off", () => {
		const checked = (accessibility: AccessibilitySettings | undefined) =>
			render(accessibility)
				.match(/<button[^>]*data-testid="toggle-follow-system-accessibility-settings"[^>]*>/)?.[0]
				.match(/aria-checked="(\w+)"/)?.[1];
		assert.equal(checked(undefined), "true");
		assert.equal(checked({ followSystem: false }), "false");
	});

	it("the groups run Presets, System, Display, Screen reader, Advanced, then Reset", () => {
		const html = render(undefined);
		const at = ["presets", "system", "display", "screen-reader", "advanced", "reset"].map((group) =>
			html.indexOf(`data-testid="group-a11y-${group}"`),
		);
		assert.ok(at.every((i) => i >= 0), "every group renders");
		assert.deepEqual([...at].sort((a, b) => a - b), at);
	});

	it("a preset is a switch, on while its values are current", () => {
		const checked = (html: string, id: string) => tagOf(html, `preset-${id}`).match(/aria-checked="(\w+)"/)?.[1];
		const tag = tagOf(render(undefined), "preset-reduce-motion");
		assert.ok(tag.includes('role="switch"'));
		assert.ok(tag.includes('aria-label="Reduce motion"'));
		assert.equal(checked(render(undefined), "reduce-motion"), "false");
		const html = render({ motion: "reduced" });
		assert.equal(checked(html, "reduce-motion"), "true");
		assert.equal(checked(html, "low-vision"), "false");
		// Screen reader also turns the graph view off.
		const reader = { expandDescriptions: true, announceToolSteps: true };
		assert.equal(checked(render(reader), "screen-reader"), "false");
		assert.equal(checked(render(reader, { graph: { rendering: false } }), "screen-reader"), "true");
	});

	it("the Screen reader toggles show the stored state", () => {
		const html = render({ expandDescriptions: true });
		assert.ok(tagOf(html, "toggle-expand-figure-descriptions").includes('aria-checked="true"'));
		assert.ok(tagOf(html, "toggle-announce-tool-steps").includes('aria-checked="false"'));
	});

	it("Advanced starts collapsed over the sliders and the WCAG check, and Reset stays outside it", () => {
		const html = render(undefined);
		const toggle = tagOf(html, "a11y-advanced-toggle");
		assert.ok(toggle.includes('aria-expanded="false"'));
		assert.ok(toggle.includes('aria-controls="a11y-advanced-panel"'));
		const at = html.indexOf('id="a11y-advanced-panel"');
		assert.ok(at >= 0, "the panel renders");
		const panel = divAt(html, html.lastIndexOf("<", at));
		assert.ok(panel.slice(0, panel.indexOf(">")).includes('hidden=""'));
		for (const id of [
			"slider-line-height",
			"slider-paragraph-spacing",
			"slider-letter-spacing",
			"slider-word-spacing",
			"slider-reading-width",
			"preset-wcag-text-spacing",
		]) {
			assert.ok(panel.includes(`data-testid="${id}"`), id);
		}
		assert.ok(html.includes('data-testid="a11y-reset"'), "Reset renders");
		assert.ok(!panel.includes('data-testid="a11y-reset"'), "outside the collapsed panel");
	});

	it("a slider reads its value, and an unset field reads Default or Full width", () => {
		const unset = render(undefined);
		assert.ok(tagOf(unset, "slider-line-height").includes('aria-valuetext="1.5 times the text size"'));
		assert.ok(tagOf(unset, "slider-paragraph-spacing").includes('aria-valuetext="Default"'));
		assert.ok(tagOf(unset, "slider-word-spacing").includes('aria-valuetext="Default"'));
		assert.ok(tagOf(unset, "slider-reading-width").includes('aria-valuetext="Full width"'));
		const set = render({ paragraphSpacing: 2, letterSpacing: 0.12, readingWidth: 80 });
		assert.ok(tagOf(set, "slider-paragraph-spacing").includes('aria-valuetext="2 times the text size"'));
		assert.ok(tagOf(set, "slider-letter-spacing").includes('aria-valuetext="0.12 times the text size"'));
		assert.ok(tagOf(set, "slider-reading-width").includes('aria-valuetext="80 characters"'));
	});

	it("a slider's Reset is offered only while its field is stored", () => {
		assert.ok(tagOf(render(undefined), "slider-line-height-reset").includes('disabled=""'));
		assert.ok(!tagOf(render({ lineHeight: 1.8 }), "slider-line-height-reset").includes('disabled=""'));
	});
});

describe("KeyboardSection (thin SSR)", () => {
	it("renders every registry action in its scope group", () => {
		const html = renderToStaticMarkup(<KeyboardSection />);
		for (const def of KEYBOARD_ACTIONS) {
			assert.ok(html.includes(`data-testid="kbd-row-${def.id}"`), def.id);
		}
		assert.ok(html.includes("kbd-scope-global"));
		assert.ok(html.includes("kbd-scope-chat"));
	});

	it("open-settings is in the registry with the settings chord", () => {
		const def = KEYBOARD_ACTIONS.find((a) => a.id === "open-settings");
		assert.ok(def, "the action exists");
		assert.equal(def?.scope, "global");
		assert.equal(def?.binding, "mod+,");
	});

	it("displayOnly actions list but never offer Rebind", () => {
		const html = renderToStaticMarkup(<KeyboardSection />);
		assert.ok(html.includes("Fixed — part of this screen"));
		assert.ok(!html.includes(`data-testid="kbd-rebind-question-next-row"`), "surface keys stay put");
		// The model-menu entries are GONE entirely (owner, 2026-10-10):
		// obvious in-field navigation, not settings material.
		assert.ok(!html.includes("Model menu"), "model-menu rows removed");
		assert.ok(!KEYBOARD_ACTIONS.some((a) => a.id as string === "model-menu-walk"));
		assert.ok(!KEYBOARD_ACTIONS.some((a) => a.id as string === "model-menu-pick"));
	});
});