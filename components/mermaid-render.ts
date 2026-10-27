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

/** The chart's base font size (px) — mermaid sizes ALL text relative to
 *  this, so it's the number the display-width cap (md-blocks) divides by:
 *  a chart shown at its natural width renders text at exactly this size.
 *  Pinned explicitly so a mermaid default change can't silently shift the
 *  cap (owner rule, chrome-melt tweaks wave, 2026-09-19: chart text must
 *  never render larger than the session's own text). */
export const MERMAID_FONT_SIZE = 16;

// The app is dark-only (html.dark in the root layout), and diagrams wear its
// own palette on mermaid's `base` theme — the stock dark theme's tinted grays
// matched nothing else on the page. Mermaid's theming engine reads literal
// hex colors only, so the app/globals.css values are copied here: change one,
// change both. Charts sit bare on the page, so shapes are raised like cards.
const PAGE = "#141414"; // --background
const RAISED = "#1c1c1c"; // --card
const ACCENT = "#2a2a2a"; // --accent
const EDGE = "#434343"; // --border
const MUTED = "#8d8d8d"; // --muted-foreground
const INK = "#e6e6e6"; // --foreground

/** Categorical colors, only for charts whose parts must be told apart (pie
 *  slices, git branches, plot series). The first is the highlight blue the
 *  formatting prompt gives a diagram's focus node (shared/40-formatting.md).
 *  Labels on them are dark. */
const SERIES = ["#60A5FA", "#FB923C", "#34D399", "#A78BFA", "#F472B6", "#FBBF24", "#22D3EE", "#A3E635"];
/** SERIES mixed 35% into ACCENT: section fills (mindmap branches, timeline
 *  periods, radar curves) that keep their hue, stay quiet on the dark page and
 *  hold INK labels at 4.7:1 or better. */
const SERIES_DIM = ["#3D5573", "#734E30", "#2E6551", "#564C73", "#71435B", "#735E28", "#27656F", "#546C2E"];

function numbered(prefix: string, first: number, count: number, color: (i: number) => string) {
	return Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}${first + i}`, color(i)]));
}
const series = (i: number) => SERIES[i % SERIES.length]!;
const seriesDim = (i: number) => SERIES_DIM[i % SERIES_DIM.length]!;

// (Moved from ai-elements/message.tsx when the renderer became app-owned;
// the old `mermaid` prop wiring is retired.)
export const mermaidTheme: MermaidConfig = {
	// The prose font (next/font sets --font-sans3 on <html>); charts render
	// and measure their labels inside the document, so the variable resolves.
	fontFamily: "var(--font-sans3), ui-sans-serif, system-ui, sans-serif",
	fontSize: MERMAID_FONT_SIZE,
	securityLevel: "strict",
	theme: "base",
	// d3's axis strokes gantt grid lines with currentColor (the page's text
	// color), which beats the theme's gridColor on the parent group.
	themeCSS: `.grid .tick line { stroke: ${EDGE}; }`,
	themeVariables: {
		darkMode: true,
		background: PAGE,
		fontSize: `${MERMAID_FONT_SIZE}px`,
		primaryColor: RAISED,
		primaryTextColor: INK,
		primaryBorderColor: MUTED,
		secondaryColor: ACCENT,
		secondaryTextColor: INK,
		secondaryBorderColor: MUTED,
		tertiaryColor: ACCENT,
		tertiaryTextColor: INK,
		tertiaryBorderColor: EDGE,
		textColor: INK,
		titleColor: INK,
		lineColor: MUTED,
		arrowheadColor: MUTED,
		clusterBkg: PAGE,
		clusterBorder: EDGE,
		edgeLabelBackground: PAGE,
		signalColor: MUTED,
		signalTextColor: INK,
		noteBkgColor: ACCENT,
		noteTextColor: INK,
		noteBorderColor: EDGE,
		activationBkgColor: ACCENT,
		activationBorderColor: MUTED,
		sequenceNumberColor: PAGE,
		rowOdd: RAISED,
		rowEven: ACCENT,
		attributeBackgroundColorOdd: RAISED,
		attributeBackgroundColorEven: ACCENT,
		relationLabelBackground: PAGE,
		// The base theme's light defaults, set dark: gantt sections, grid and
		// tasks; architecture groups.
		sectionBkgColor: ACCENT,
		altSectionBkgColor: PAGE,
		sectionBkgColor2: RAISED,
		excludeBkgColor: RAISED,
		gridColor: EDGE,
		taskBkgColor: ACCENT,
		taskBorderColor: MUTED,
		taskTextClickableColor: SERIES[0],
		activeTaskBkgColor: EDGE,
		activeTaskBorderColor: SERIES[0],
		doneTaskBkgColor: RAISED,
		doneTaskBorderColor: EDGE,
		critBkgColor: "#431407",
		critBorderColor: SERIES[1],
		todayLineColor: SERIES[1],
		vertLineColor: MUTED,
		quadrantPointFill: SERIES[0],
		// The section scale (mindmap, timeline, kanban, treemap, radar).
		// darkMode darkens it to near-black and derives the inverse (node
		// underlines) and peers (treemap outlines) from that, so all are set.
		...numbered("cScale", 0, 12, seriesDim),
		...numbered("cScaleInv", 0, 12, series),
		...numbered("cScalePeer", 0, 12, series),
		scaleLabelColor: INK,
		archEdgeColor: MUTED,
		archEdgeArrowColor: MUTED,
		archGroupBorderColor: EDGE,
		// Gray hue-shifts are all the same gray, so categorical charts get
		// SERIES. git0 also fills the mindmap and timeline root.
		...numbered("pie", 1, 12, series),
		pieStrokeColor: PAGE,
		pieOuterStrokeColor: PAGE,
		pieSectionTextColor: PAGE,
		pieOpacity: "1",
		...numbered("git", 0, 8, series),
		...numbered("gitInv", 0, 8, () => INK),
		branchLabelColor: PAGE,
		...numbered("venn", 1, 8, series),
		// Mermaid merges a partial xyChart over the LIGHT default theme's, so
		// every field is set.
		xyChart: {
			backgroundColor: PAGE,
			titleColor: INK,
			dataLabelColor: PAGE,
			legendTextColor: INK,
			xAxisTitleColor: INK,
			xAxisLabelColor: INK,
			xAxisTickColor: MUTED,
			xAxisLineColor: MUTED,
			yAxisTitleColor: INK,
			yAxisLabelColor: INK,
			yAxisTickColor: MUTED,
			yAxisLineColor: MUTED,
			plotColorPalette: SERIES.join(","),
		},
	},
};

const plugin = createMermaidPlugin();

/** Render one chart source to an svg string. The id is unique per call —
 *  mermaid caches rendered ids, and a repeated id across charts/renders
 *  returns the stale svg (the bug streamdown's own id minting avoids). */
export async function renderMermaid(chart: string): Promise<string> {
	const id = `lh-mermaid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
	const { svg } = await plugin.getMermaid(mermaidTheme).render(id, chart);
	return svg;
}
