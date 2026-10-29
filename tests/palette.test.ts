/**
 * The palette contract (design wave, docs/design.md): app/globals.css and
 * src/core/palette.ts carry the same hex values (generators read the TS
 * copy, the page reads the CSS), and the contrast floors the design
 * promises hold in both modes — including the fills Mermaid derives.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PALETTE, PALETTE_VARS, VIZ_VARS, contrastRatio, mixHex, vividHex } from "../src/core/palette.ts";
import { CODE_THEME, codeSurface } from "../src/core/code-theme.ts";
import { DEFAULT_REGION_TUNING } from "../src/core/render-settings.ts";
import { houseColors, mermaidConfig } from "../components/mermaid-render.ts";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** The hex custom properties one top-level rule declares. */
function declared(selector: string): Map<string, string> {
	const start = css.indexOf(`\n${selector} {`);
	assert.ok(start >= 0, `${selector} block present`);
	const body = css.slice(start, css.indexOf("\n}", start));
	return new Map([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
}

const SCHEMES = [
	["light", ":root"],
	["dark", ".dark"],
] as const;

describe("palette — globals.css and palette.ts agree", () => {
	for (const [scheme, selector] of SCHEMES) {
		it(`${scheme} (${selector})`, () => {
			const tokens = declared(selector);
			const p = PALETTE[scheme];
			for (const key of Object.keys(PALETTE_VARS) as (keyof typeof PALETTE_VARS)[]) {
				assert.equal(tokens.get(PALETTE_VARS[key]), p[key], PALETTE_VARS[key]);
			}
			VIZ_VARS.forEach((cssVar, i) => assert.equal(tokens.get(cssVar), p.viz[i], cssVar));
		});
	}
});

describe("palette — contrast floors", () => {
	for (const [scheme] of SCHEMES) {
		it(`${scheme}: inks >= 4.5:1, data hues >= 3:1, on page and card`, () => {
			const p = PALETTE[scheme];
			for (const surface of [p.background, p.card]) {
				for (const ink of [p.foreground, p.mutedForeground, p.brand, p.success, p.warning, p.danger]) {
					assert.ok(contrastRatio(ink, surface) >= 4.5, `${ink} on ${surface}`);
				}
				for (const hue of p.viz) assert.ok(contrastRatio(hue, surface) >= 3, `${hue} on ${surface}`);
			}
			assert.ok(contrastRatio(p.brandForeground, p.brand) >= 4.5, "text on the brand button");
		});
	}
});

describe("graph regions — the vivid washes read as color but stay quiet", () => {
	const channels = (h: string) => [0, 1, 2].map((i) => Number.parseInt(h.slice(1 + i * 2, 3 + i * 2), 16));
	const spread = (h: string) => Math.max(...channels(h)) - Math.min(...channels(h));
	const hueOrder = (h: string) => {
		const c = channels(h);
		return [c.indexOf(Math.max(...c)), c.indexOf(Math.min(...c))];
	};
	for (const [scheme] of SCHEMES) {
		it(scheme, () => {
			const p = PALETTE[scheme];
			for (const hue of p.viz) {
				const wash = vividHex(hue);
				assert.deepEqual(hueOrder(wash), hueOrder(hue), `${hue} keeps its hue`);
				// The field the canvas lays down: the wash at the default region alpha.
				const field = mixHex(p.background, wash, DEFAULT_REGION_TUNING.edgeAlpha);
				assert.ok(spread(field) >= 16, `${hue}: region field ${field} reads as color, not grey`);
				assert.ok(contrastRatio(field, p.background) <= 1.6, `${hue}: region field ${field} stays a tint`);
			}
		});
	}
});

describe("mermaid theme — labels hold 4.5:1 on every derived fill", () => {
	for (const [scheme] of SCHEMES) {
		it(scheme, () => {
			const v = mermaidConfig(PALETTE[scheme], scheme).themeVariables as Record<string, string>;
			for (let i = 0; i < 6; i++) {
				assert.ok(contrastRatio(v.pieSectionTextColor!, v[`pie${i + 1}`]!) >= 4.5, `pie${i + 1}`);
				assert.ok(contrastRatio(v.branchLabelColor!, v[`git${i}`]!) >= 4.5, `git${i}`);
				assert.ok(contrastRatio(v.scaleLabelColor!, v[`cScale${i}`]!) >= 4.5, `cScale${i}`);
			}
			assert.ok(contrastRatio(v.textColor!, v.critBkgColor!) >= 4.5, "critical gantt task");
		});
	}
});

describe("code themes — house hues that read on the code surface", () => {
	it("codeSurface() mirrors the --code-surface formulas in globals.css", () => {
		const light = /\n:root \{[^}]*--code-surface: color-mix\(in oklab, var\(--background\) (\d+)%, var\(--foreground\)\);/.exec(css);
		const dark = /\n\.dark \{[^}]*--code-surface: color-mix\(in oklab, var\(--background\) (\d+)%, black\);/.exec(css);
		assert.ok(light && dark, "both --code-surface formulas present");
		assert.equal(codeSurface("light"), mixHex(PALETTE.light.background, PALETTE.light.foreground, 1 - Number(light[1]) / 100));
		assert.equal(codeSurface("dark"), mixHex(PALETTE.dark.background, "#000000", 1 - Number(dark[1]) / 100));
	});
	for (const [scheme] of SCHEMES) {
		it(`${scheme}: every token >= 4.5:1 on the code surface, page, and card`, () => {
			const p = PALETTE[scheme];
			const t = CODE_THEME[scheme];
			const inks = [t.fg, ...t.tokenColors.flatMap((r) => r.settings.foreground ?? [])];
			for (const surface of [codeSurface(scheme), p.background, p.card]) {
				for (const ink of inks) assert.ok(contrastRatio(ink, surface) >= 4.5, `${ink} on ${surface}`);
			}
		});
	}
});

describe("mermaid — a chart's own colors snap to the house palette", () => {
	// A real tutor chart (Material colors, one meaning per class).
	const KNOWLEDGE_MAP = [
		"graph TD",
		"  A[Tokens] --> B[style guide]",
		"  classDef solid fill:#c8e6c9,stroke:#2e7d32,color:#000",
		"  classDef shaky fill:#fff3c4,stroke:#b8860b,color:#000",
		"  classDef wrong fill:#ffcdd2,stroke:#c62828,color:#000",
		"  classDef missing fill:#eeeeee,stroke:#757575,color:#000",
		"  classDef untested fill:#ffffff,stroke:#9e9e9e,stroke-dasharray:4 3,color:#000",
		"  classDef goal fill:#bbdefb,stroke:#1565c0,color:#000",
		"  classDef focus stroke:#60A5FA,stroke-width:2px",
		"  style B fill:rgb(255, 0, 0),stroke:papayawhip",
		"  class A solid",
	].join("\n");

	for (const [scheme] of SCHEMES) {
		const p = PALETTE[scheme];
		const tint = (hex: string) => mixHex(scheme === "dark" ? p.accent : p.card, hex, scheme === "dark" ? 0.3 : 0.2);

		it(`${scheme}: each class keeps its meaning in house hues`, () => {
			const out = houseColors(KNOWLEDGE_MAP, p, scheme).split("\n");
			const ink = `color:${p.foreground}`;
			assert.equal(out[1], "  A[Tokens] --> B[style guide]");
			assert.equal(out[2], `  classDef solid fill:${tint(p.success)},stroke:${p.success},${ink}`);
			assert.equal(out[3], `  classDef shaky fill:${tint(p.warning)},stroke:${p.warning},${ink}`);
			assert.equal(out[4], `  classDef wrong fill:${tint(p.danger)},stroke:${p.danger},${ink}`);
			assert.equal(out[5], `  classDef missing fill:${p.accent},stroke:${p.ring},${ink}`);
			assert.equal(out[6], `  classDef untested fill:${p.card},stroke:${p.ring},stroke-dasharray:4 3,${ink}`);
			assert.equal(out[7], `  classDef goal fill:${tint(p.viz[1])},stroke:${p.viz[1]},${ink}`);
			assert.equal(out[8], "  classDef focus stroke-width:2px", "the theme draws focus in --brand");
			assert.equal(out[9], `  style B fill:${tint(p.danger)}`, "rgb() read whole; an unreadable name dropped");
			assert.equal(out[10], "  class A solid");
		});

		it(`${scheme}: any authored hue still holds ink labels at 4.5:1`, () => {
			const wheel = Array.from({ length: 24 }, (_, i) => `  style N${i} fill:hsl,stroke:hsl`.replace(/hsl/g, hslHex(i * 15)));
			const out = houseColors(wheel.join("\n"), p, scheme);
			const pairs = [...out.matchAll(/fill:(#[0-9a-f]{6}),stroke:(#[0-9a-f]{6})/g)];
			assert.equal(pairs.length, wheel.length);
			for (const [, fill, stroke] of pairs) {
				assert.ok(contrastRatio(p.foreground, fill!) >= 4.5, `ink on ${fill}`);
				assert.ok(contrastRatio(stroke!, p.background) >= 3, `${stroke} on the page`);
			}
		});
	}

	it("sequence rects become tints; names resolve through the browser hook", () => {
		const p = PALETTE.light;
		const tint = (hex: string) => mixHex(p.card, hex, 0.2);
		const seq = ["sequenceDiagram", "  rect rgb(191, 223, 255)", "  A->>B: hi", "  end", "  rect papayawhip", "  end"];
		const out = houseColors(seq.join("\n"), p, "light", (css) => (css === "papayawhip" ? "#ffefd5" : null)).split("\n");
		assert.equal(out[1], `  rect ${tint(p.viz[1])}`);
		assert.equal(out[2], "  A->>B: hi");
		assert.equal(out[4], `  rect ${tint(p.warning)}`);
	});
});

/** A saturated mid-light color at `hue` degrees, as `#rrggbb`. */
function hslHex(hue: number): string {
	const f = (n: number) => {
		const k = (n + hue / 30) % 12;
		const v = 0.5 - 0.4 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
		return Math.round(v * 255).toString(16).padStart(2, "0");
	};
	return `#${f(0)}${f(8)}${f(4)}`;
}