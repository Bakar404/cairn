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

/** WCAG 2 contrast ratio between two `#rrggbb` colors. */
export function contrastRatio(a: string, b: string): number {
	const lum = (h: string) => {
		const [r, g, bl] = [0, 1, 2].map((i) => {
			const v = Number.parseInt(h.slice(1 + i * 2, 3 + i * 2), 16) / 255;
			return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
		}) as [number, number, number];
		return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
	};
	const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
	return (hi + 0.05) / (lo + 0.05);
}
