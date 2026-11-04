/**
 * THE PALETTE as data (design wave, docs/design.md). app/globals.css owns
 * the live tokens; this is the same set of hex values for every consumer
 * that cannot read CSS — generator prompts (demos, visuals, Manim), the
 * demo house kit, the theme-color meta, the Electron title bar.
 * tests/palette.test.ts fails the moment the two drift.
 *
 * Browser painters (graph canvas, Mermaid) read the LIVE tokens instead
 * (components/theme-tokens.ts) so a custom background still applies; this
 * table is their fallback.
 */

import type { ColorScheme } from "./theme-mode.ts";

export interface SchemePalette {
	background: string;
	foreground: string;
	card: string;
	muted: string;
	accent: string;
	border: string;
	input: string;
	ring: string;
	mutedForeground: string;
	brand: string;
	brandForeground: string;
	success: string;
	warning: string;
	danger: string;
	/** The data hues, in their fixed order. */
	viz: readonly [string, string, string, string, string, string];
	vizMuted: string;
}

export const PALETTE: Readonly<Record<ColorScheme, SchemePalette>> = {
	light: {
		background: "#f9f5ed",
		foreground: "#132243",
		card: "#fdfbf7",
		muted: "#f2ece1",
		accent: "#ece7dc",
		border: "#e1dcd1",
		input: "#d7d2c7",
		ring: "#848c9c",
		mutedForeground: "#5e6a82",
		brand: "#2d62e7",
		brandForeground: "#fdfbf7",
		success: "#217f40",
		warning: "#9c6200",
		danger: "#c5403f",
		viz: ["#408ad8", "#cc6e32", "#359953", "#af6ec3", "#a58300", "#009698"],
		vizMuted: "#8d929c",
	},
	dark: {
		background: "#0c121d",
		foreground: "#efe7d8",
		card: "#111825",
		muted: "#171e2d",
		accent: "#1c2433",
		border: "#283140",
		input: "#323b4a",
		ring: "#7a8798",
		mutedForeground: "#9aa6b5",
		brand: "#71b1fe",
		brandForeground: "#0c121d",
		success: "#7fd091",
		warning: "#f4c26a",
		danger: "#f3817c",
		viz: ["#74b2f8", "#f2925b", "#73c385", "#ce95df", "#cfa936", "#2bc5c7"],
		vizMuted: "#6e757f",
	},
};

type ScalarKey = Exclude<keyof SchemePalette, "viz">;

/** The CSS custom property behind each scalar palette key. */
export const PALETTE_VARS: Readonly<Record<ScalarKey, string>> = {
	background: "--background",
	foreground: "--foreground",
	card: "--card",
	muted: "--muted",
	accent: "--accent",
	border: "--border",
	input: "--input",
	ring: "--ring",
	mutedForeground: "--muted-foreground",
	brand: "--brand",
	brandForeground: "--brand-foreground",
	success: "--success",
	warning: "--warning",
	danger: "--danger",
	vizMuted: "--viz-muted",
};

export const VIZ_VARS = ["--viz-1", "--viz-2", "--viz-3", "--viz-4", "--viz-5", "--viz-6"] as const;

/** `#rrggbb` blend: `t` of `b` into `a` (sRGB, like the CSS fallbacks). */
export function mixHex(a: string, b: string, t: number): string {
	const ch = (h: string, i: number) => Number.parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
	return `#${[0, 1, 2]
		.map((i) => Math.round(ch(a, i) * (1 - t) + ch(b, i) * t).toString(16).padStart(2, "0"))
		.join("")}`;
}

/** A data hue pushed away from its own grey (same hue, same luma, more
 *  chroma) until its channel spread reaches `spread`; the boost is capped
 *  and never a cut. For color laid down at low alpha (the graph's cluster
 *  regions): a muted chart hue dilutes to grey there, its vivid twin to a
 *  soft tint of the same color. */
export function vividHex(hex: string, spread = 115, maxBoost = 2): string {
	const c = [0, 1, 2].map((i) => Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16));
	const luma = 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
	const now = Math.max(...c) - Math.min(...c);
	const boost = now > 0 ? Math.min(maxBoost, Math.max(1, spread / now)) : 1;
	return `#${c
		.map((v) => Math.min(255, Math.max(0, Math.round(luma + (v - luma) * boost))).toString(16).padStart(2, "0"))
		.join("")}`;
}

/** WCAG 2 relative luminance of a `#rrggbb` color. */
function luminance(hex: string): number {
	const [r, g, b] = [0, 1, 2].map((i) => {
		const v = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio between two `#rrggbb` colors. */
export function contrastRatio(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
	return (hi + 0.05) / (lo + 0.05);
}

/** An OKLab color: lightness 0–1, then the a and b axes. Hue and chroma
 *  live in a and b, so moving L alone keeps both. */
export type Oklab = readonly [number, number, number];

/** OKLab (Björn Ottosson's) of a `#rrggbb` color. */
export function hexToOklab(hex: string): Oklab {
	const [r, g, b] = [0, 1, 2].map((i) => {
		const v = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
		return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	];
}

/** Linear sRGB of an OKLab color; channels outside 0–1 are out of gamut. */
function oklabToLinear([L, a, b]: Oklab): [number, number, number] {
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	];
}

const inGamut = (rgb: readonly number[]) => rgb.every((c) => c >= -1e-7 && c <= 1 + 1e-7);

/** `#rrggbb` for an OKLab color. A color outside sRGB keeps its lightness
 *  and hue and gives up chroma until it fits. */
export function oklabToHex(lab: Oklab): string {
	const [L, a, b] = lab;
	let rgb = oklabToLinear(lab);
	if (!inGamut(rgb)) {
		let lo = 0;
		let hi = 1;
		for (let i = 0; i < 40; i++) {
			const k = (lo + hi) / 2;
			if (inGamut(oklabToLinear([L, a * k, b * k]))) lo = k;
			else hi = k;
		}
		rgb = oklabToLinear([L, a * lo, b * lo]);
	}
	return `#${rgb
		.map((c) => {
			const v = Math.min(1, Math.max(0, c));
			const s = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
			return Math.round(s * 255).toString(16).padStart(2, "0");
		})
		.join("")}`;
}

/** The soft tints: each semantic color laid at this alpha under its own
 *  text (globals.css --brand-soft and friends; the bg-danger/12 washes). */
export const SOFT_TINTS = { brand: 0.12, success: 0.12, warning: 0.14, danger: 0.12 } as const;

/** The ratios high contrast promises (WCAG 2), each against its surfaces. */
export const HIGH_CONTRAST_FLOORS = {
	/** The inks (text, the brand, the semantic colors) on page, card, muted
	 *  and accent: WCAG's enhanced contrast, AAA. A semantic ink also holds
	 *  it on its own soft tint, laid on the page or a card. */
	text: 7,
	/** Hairlines, field edges and the ring, on the same four surfaces. */
	edge: 4.5,
	/** The data colors, on page and card. */
	data: 4.5,
} as const;

const LIGHTNESS_STEP = 0.001;

/** A color's own wash: `alpha` of it laid on each of `over`. */
interface Tint {
	alpha: number;
	over: readonly string[];
}

/** `hex` with only its OKLab lightness moved, away from `surfaces` and by
 *  the least that holds `floor` against each of them (and against its own
 *  `tint`, which moves with it). */
function reach(hex: string, surfaces: readonly string[], floor: number, tint?: Tint): string {
	const holds = (h: string) =>
		[...surfaces, ...(tint?.over.map((s) => mixHex(s, h, tint.alpha)) ?? [])].every((s) => contrastRatio(h, s) >= floor);
	if (holds(hex)) return hex;
	const [L, a, b] = hexToOklab(hex);
	// Darker on light surfaces, lighter on dark ones.
	const end = luminance(hex) < luminance(surfaces[0]!) ? 0 : 1;
	const steps = Math.ceil(Math.abs(end - L) / LIGHTNESS_STEP);
	for (let i = 1; i <= steps; i++) {
		const next = oklabToHex([i === steps ? end : L + Math.sign(end - L) * i * LIGHTNESS_STEP, a, b]);
		if (holds(next)) return next;
	}
	throw new Error(`${hex} can't reach ${floor}:1 by lightness alone`);
}

/** The high-contrast twin of a palette (accessibility mode, M27). The
 *  surfaces stay; every ink, edge and data color moves in lightness only,
 *  keeping its hue and chroma, until it holds HIGH_CONTRAST_FLOORS. Where
 *  sRGB can't hold the chroma at the new lightness, the hue still holds.
 *  Text on the brand button holds the text floor against the moved brand. */
export function highContrast(p: SchemePalette): SchemePalette {
	const surfaces = [p.background, p.card, p.muted, p.accent];
	const page = [p.background, p.card];
	const text = (hex: string) => reach(hex, surfaces, HIGH_CONTRAST_FLOORS.text);
	const semantic = (key: keyof typeof SOFT_TINTS) =>
		reach(p[key], surfaces, HIGH_CONTRAST_FLOORS.text, { alpha: SOFT_TINTS[key], over: page });
	const edge = (hex: string) => reach(hex, surfaces, HIGH_CONTRAST_FLOORS.edge);
	const data = (hex: string) => reach(hex, page, HIGH_CONTRAST_FLOORS.data);
	const brand = semantic("brand");
	return {
		...p,
		foreground: text(p.foreground),
		mutedForeground: text(p.mutedForeground),
		brand,
		brandForeground: reach(p.brandForeground, [brand], HIGH_CONTRAST_FLOORS.text),
		success: semantic("success"),
		warning: semantic("warning"),
		danger: semantic("danger"),
		border: edge(p.border),
		input: edge(p.input),
		ring: edge(p.ring),
		viz: p.viz.map(data) as unknown as SchemePalette["viz"],
		vizMuted: data(p.vizMuted),
	};
}

/** highContrast(PALETTE), written out: the html[data-contrast="high"]
 *  blocks in app/globals.css carry these values, and
 *  tests/palette.test.ts regenerates them, so nothing computes at runtime. */
export const PALETTE_HC: Readonly<Record<ColorScheme, SchemePalette>> = {
	light: {
		...PALETTE.light,
		border: "#6c685e",
		input: "#6c685e",
		ring: "#616878",
		mutedForeground: "#404c62",
		brand: "#0935b9",
		success: "#005322",
		warning: "#633c00",
		danger: "#8f0014",
		viz: ["#2773bf", "#b35715", "#14823d", "#9757aa", "#8a6d00", "#007e7f"],
		vizMuted: "#6c717b",
	},
	dark: {
		...PALETTE.dark,
		border: "#808b9c",
		input: "#808b9c",
		ring: "#7e8c9d",
		mutedForeground: "#a4b0bf",
		brand: "#81baff",
		danger: "#ff9993",
		vizMuted: "#7a818b",
	},
};
