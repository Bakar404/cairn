/**
 * The app's ONE mermaid renderer (the chrome-melt wave, 2026-09-19): both the
 * in-chat block (components/md-blocks.tsx) and the session-scoped focus
 * overlay (components/session-overlay.tsx) render charts through this module
 * — one themed config, one plugin instance, unique render ids. This
 * REPLACES streamdown's internal mermaid path entirely: its fullscreen portal
 * was hard-wired `fixed inset-0` (covering the window-drag bar, X landing in
 * drag territory) with no styling hook, which is what drove the custom
 * component in the first place.
 */

import { createMermaidPlugin } from "@streamdown/mermaid";
import type { MermaidConfig } from "mermaid";
import { currentScheme } from "@/components/color-scheme";
import { cssColorToHex, livePalette } from "@/components/theme-tokens";
import { mixHex, type ColorScheme, type SchemePalette } from "@/src/core";

/** The chart's base font size (px) — mermaid sizes ALL text relative to
 *  this, so it's the number the display-width cap (md-blocks) divides by:
 *  a chart shown at its natural width renders text at exactly this size.
 *  Pinned explicitly so a mermaid default change can't silently shift the
 *  cap (owner rule, chrome-melt tweaks wave, 2026-09-19: chart text must
 *  never render larger than the session's own text). */
export const MERMAID_FONT_SIZE = 16;

/** Config keys a chart's own `%%{init}%%` / frontmatter may not override:
 *  mermaid's defaults plus everything that sets the look. */
const SECURE_KEYS = [
	"secure",
	"securityLevel",
	"startOnLoad",
	"maxTextSize",
	"suppressErrorRendering",
	"maxEdges",
	"theme",
	"themeVariables",
	"themeCSS",
	"darkMode",
	"fontFamily",
	"altFontFamily",
	"fontSize",
	"look",
	"handDrawnSeed",
];

type Rgb = readonly [number, number, number];
type ColorRole = "fill" | "stroke" | "text";

/** Style properties that carry a color, by the job the color does. */
const COLOR_ROLES: Readonly<Record<string, ColorRole>> = {
	fill: "fill",
	background: "fill",
	"background-color": "fill",
	stroke: "stroke",
	"stroke-color": "stroke",
	"border-color": "stroke",
	color: "text",
};

/** Below this chroma an authored color reads as gray. */
const NEUTRAL_CHROMA = 0.08;

const STYLE_LINE = /^(\s*(classDef|style|linkStyle)\s+(\S+)\s+)(.+?)(\s*;?\s*)$/;
const RECT_LINE = /^(\s*rect\s+)(.+?)(\s*)$/;
const BOX_LINE = /^(\s*box\s+)(rgba?\([^)]*\)|#[0-9a-f]{3,8}\b)(.*)$/i;

function parseColor(value: string, resolve: (css: string) => string | null): Rgb | null {
	const v = value.trim().toLowerCase();
	const hex = /^#([0-9a-f]{3,8})$/.exec(v)?.[1];
	if (hex) {
		const full = hex.length <= 4 ? [...hex.slice(0, 3)].map((c) => c + c).join("") : hex.slice(0, 6);
		return full.length === 6 ? ([0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as unknown as Rgb) : null;
	}
	const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(v);
	if (rgb) return [rgb[1], rgb[2], rgb[3]].map((n) => Math.min(255, Math.round(Number(n)))) as unknown as Rgb;
	const resolved = resolve(v);
	return resolved ? parseColor(resolved, () => null) : null;
}

function hueOf([r, g, b]: Rgb): { hue: number; chroma: number; lightness: number } {
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;
	const lightness = (max + min) / 510;
	if (d === 0) return { hue: 0, chroma: 0, lightness };
	const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return { hue: h * 60, chroma: d / 255, lightness };
}

const arc = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

/** A chart's own colors (`classDef`, `style`, `linkStyle`, sequence `rect`
 *  and `box`) snapped onto the house palette, so an old transcript or a
 *  model that ignores the formatting prompt still draws in Cairn's colors.
 *  The MEANING survives: each colored value lands on the nearest house hue
 *  (red/amber/green on danger/warning/success, the rest on the data hues),
 *  fills become quiet tints under ink labels, strokes keep the full hue,
 *  grays become the page's neutrals. A `focus` classDef loses its colors —
 *  the theme draws the one focal mark in --brand. Colors that can't be
 *  read are dropped. `resolve` turns CSS color names into hex (the browser
 *  passes a canvas round-trip). Pure — exported for tests. */
export function houseColors(
	chart: string,
	p: SchemePalette,
	scheme: ColorScheme,
	resolve: (css: string) => string | null = () => null,
): string {
	const dark = scheme === "dark";
	const hues = [p.danger, p.viz[0], p.warning, p.success, p.viz[5], p.viz[1], p.viz[3]].flatMap((hex) => {
		const rgb = parseColor(hex, () => null);
		return rgb ? [{ hex, hue: hueOf(rgb).hue }] : [];
	});
	const tint = (hex: string) => mixHex(dark ? p.accent : p.card, hex, dark ? 0.3 : 0.2);
	const snap = (role: ColorRole, value: string): string | null => {
		const v = value.trim();
		if (/^(none|transparent|inherit|currentcolor)$/i.test(v)) return v;
		if (role === "text") return p.foreground;
		const rgb = parseColor(v, resolve);
		if (!rgb) return null;
		const { hue, chroma, lightness } = hueOf(rgb);
		if (chroma < NEUTRAL_CHROMA) {
			if (role === "stroke") return p.ring;
			return lightness >= 0.97 ? p.card : p.accent;
		}
		const nearest = hues.reduce((best, c) => (arc(c.hue, hue) < arc(best.hue, hue) ? c : best)).hex;
		return role === "fill" ? tint(nearest) : nearest;
	};
	return chart
		.split("\n")
		.flatMap((line) => {
			const style = STYLE_LINE.exec(line);
			if (style) {
				const [, head, kind, names, body, tail] = style as unknown as [string, string, string, string, string, string];
				const focus = kind === "classDef" && names.split(",").includes("focus");
				const props = body.split(/,(?![^(]*\))/).flatMap((prop) => {
					const at = prop.indexOf(":");
					const key = at < 0 ? "" : prop.slice(0, at).trim();
					const role = COLOR_ROLES[key.toLowerCase()];
					if (!role) return [prop];
					const value = focus ? null : snap(role, prop.slice(at + 1));
					return value ? [`${key}:${value}`] : [];
				});
				return props.length ? [head + props.join(",") + tail] : [];
			}
			const rect = RECT_LINE.exec(line);
			if (rect) return [rect[1] + (snap("fill", rect[2]!) ?? p.accent) + rect[3]];
			const box = BOX_LINE.exec(line);
			if (box) return [box[1] + (snap("fill", box[2]!) ?? p.accent) + box[3]];
			return [line];
		})
		.join("\n");
}

function numbered(prefix: string, first: number, count: number, color: (i: number) => string) {
	return Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}${first + i}`, color(i)]));
}
const cycle = (list: readonly string[]) => (i: number) => list[i % list.length]!;

/** Diagrams wear the app's own palette (design wave, docs/design.md) on
 *  mermaid's `base` theme: the page's surfaces and inks, hairline edges in
 *  --ring, the --viz-1..6 data hues in their fixed order, --brand for the
 *  one focal mark. Mermaid's theme engine runs color math on literal hex,
 *  so the palette arrives resolved (renderMermaid reads the live tokens).
 *  Pure — exported for tests. */
export function mermaidConfig(p: SchemePalette, scheme: ColorScheme): MermaidConfig {
	const dark = scheme === "dark";
	const PAGE = p.background;
	const RAISED = p.card;
	const ACCENT = p.accent;
	const EDGE = p.border;
	const LINE = p.ring;
	const MUTED = p.mutedForeground;
	const INK = p.foreground;
	const BRAND = p.brand;
	/** Marks (lines, points, bars, underlines): the data hues as-is. */
	const series = cycle(p.viz);
	/** Labeled areas (pie slices, git branches, the mindmap root). Dark:
	 *  full strength under page-ink labels (>= 6.7:1). Light: 70% toward
	 *  paper under the text ink (>= 5.8:1) — no single label color clears
	 *  4.5:1 on all six full-strength hues. */
	const fills = cycle(dark ? p.viz : p.viz.map((c) => mixHex(RAISED, c, 0.7)));
	const onFill = dark ? PAGE : INK;
	/** Section tints (mindmap branches, timeline periods, radar curves):
	 *  keep their hue, stay quiet, hold INK labels (>= 6.3:1 / >= 12:1). */
	const sections = cycle(p.viz.map((c) => (dark ? mixHex(ACCENT, c, 0.3) : mixHex(RAISED, c, 0.2))));
	return {
		// The prose font (next/font sets --font-sans3 on <html>); charts render
		// and measure their labels inside the document, so the variable resolves.
		fontFamily: "var(--font-sans3), ui-sans-serif, system-ui, sans-serif",
		fontSize: MERMAID_FONT_SIZE,
		securityLevel: "strict",
		secure: SECURE_KEYS,
		theme: "base",
		// d3's axis strokes gantt grid lines with currentColor (the page's text
		// color), which beats the theme's gridColor on the parent group. The
		// focus class (shared/40-formatting.md) is the one focal mark.
		themeCSS: [
			`.grid .tick line { stroke: ${EDGE}; }`,
			`.node.focus rect, .node.focus circle, .node.focus ellipse, .node.focus polygon, .node.focus path { stroke: ${BRAND}; stroke-width: 2px; }`,
		].join("\n"),
		themeVariables: {
			darkMode: dark,
			background: PAGE,
			fontSize: `${MERMAID_FONT_SIZE}px`,
			primaryColor: RAISED,
			primaryTextColor: INK,
			primaryBorderColor: LINE,
			secondaryColor: ACCENT,
			secondaryTextColor: INK,
			secondaryBorderColor: LINE,
			tertiaryColor: ACCENT,
			tertiaryTextColor: INK,
			tertiaryBorderColor: EDGE,
			textColor: INK,
			titleColor: INK,
			lineColor: LINE,
			arrowheadColor: LINE,
			clusterBkg: PAGE,
			clusterBorder: EDGE,
			edgeLabelBackground: PAGE,
			signalColor: MUTED,
			signalTextColor: INK,
			noteBkgColor: ACCENT,
			noteTextColor: INK,
			noteBorderColor: EDGE,
			activationBkgColor: ACCENT,
			activationBorderColor: LINE,
			sequenceNumberColor: PAGE,
			rowOdd: RAISED,
			rowEven: ACCENT,
			attributeBackgroundColorOdd: RAISED,
			attributeBackgroundColorEven: ACCENT,
			relationLabelBackground: PAGE,
			// Gantt sections, grid and tasks; architecture groups.
			sectionBkgColor: ACCENT,
			altSectionBkgColor: PAGE,
			sectionBkgColor2: RAISED,
			excludeBkgColor: RAISED,
			gridColor: EDGE,
			taskBkgColor: ACCENT,
			taskBorderColor: LINE,
			taskTextClickableColor: BRAND,
			activeTaskBkgColor: EDGE,
			activeTaskBorderColor: BRAND,
			doneTaskBkgColor: RAISED,
			doneTaskBorderColor: EDGE,
			critBkgColor: mixHex(dark ? PAGE : RAISED, p.danger, dark ? 0.18 : 0.12),
			critBorderColor: p.danger,
			todayLineColor: BRAND,
			vertLineColor: MUTED,
			quadrantPointFill: BRAND,
			// The section scale (mindmap, timeline, kanban, treemap, radar).
			// darkMode darkens it to near-black and derives the inverse (node
			// underlines) and peers (treemap outlines) from that, so all are set.
			...numbered("cScale", 0, 12, sections),
			...numbered("cScaleInv", 0, 12, series),
			...numbered("cScalePeer", 0, 12, series),
			scaleLabelColor: INK,
			archEdgeColor: LINE,
			archEdgeArrowColor: LINE,
			archGroupBorderColor: EDGE,
			// Gray hue-shifts are all the same gray, so categorical charts get
			// the data hues. git0 also fills the mindmap and timeline root.
			...numbered("pie", 1, 12, fills),
			pieStrokeColor: PAGE,
			pieOuterStrokeColor: PAGE,
			pieSectionTextColor: onFill,
			pieOpacity: "1",
			...numbered("git", 0, 8, fills),
			...numbered("gitInv", 0, 8, () => INK),
			branchLabelColor: onFill,
			...numbered("venn", 1, 8, series),
			// Mermaid merges a partial xyChart over the LIGHT default theme's, so
			// every field is set.
			xyChart: {
				backgroundColor: PAGE,
				titleColor: INK,
				dataLabelColor: dark ? PAGE : RAISED,
				legendTextColor: INK,
				xAxisTitleColor: INK,
				xAxisLabelColor: INK,
				xAxisTickColor: LINE,
				xAxisLineColor: LINE,
				yAxisTitleColor: INK,
				yAxisLabelColor: INK,
				yAxisTickColor: LINE,
				yAxisLineColor: LINE,
				plotColorPalette: p.viz.join(","),
			},
		},
	};
}

const plugin = createMermaidPlugin();

/** Render one chart source to an svg string, in the page's current palette
 *  (callers re-render on usePaletteKey). The id is unique per call —
 *  mermaid caches rendered ids, and a repeated id across charts/renders
 *  returns the stale svg (the bug streamdown's own id minting avoids). */
export async function renderMermaid(chart: string, scheme: ColorScheme = currentScheme()): Promise<string> {
	const id = `lh-mermaid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
	const palette = livePalette(scheme);
	const source = houseColors(chart, palette, scheme, cssColorToHex);
	const { svg } = await plugin.getMermaid(mermaidConfig(palette, scheme)).render(id, source);
	return svg;
}