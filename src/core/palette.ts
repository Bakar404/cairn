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
		background: "#f8f5f1",
		foreground: "#211e19",
		card: "#fcfbf9",
		muted: "#f0ece7",
		accent: "#eae7e1",
		border: "#e0dcd5",
		input: "#d6d2cb",
		ring: "#918b83",
		mutedForeground: "#69645c",
		brand: "#ab532f",
		brandForeground: "#fcfbf9",
		success: "#3f7849",
		warning: "#946523",
		danger: "#af3c3a",
		viz: ["#b76849", "#5377a0", "#668c5e", "#936188", "#ac853f", "#428787"],
		vizMuted: "#8f8c85",
	},
	dark: {
		background: "#131210",
		foreground: "#e9e6e0",
		card: "#191816",
		muted: "#201e1b",
		accent: "#262421",
		border: "#33302c",
		input: "#3d3a35",
		ring: "#8a857e",
		mutedForeground: "#9f9b93",
		brand: "#db8862",
		brandForeground: "#131210",
		success: "#87c28f",
		warning: "#e3ba74",
		danger: "#e7827b",
		viz: ["#d58966", "#7fa2c9", "#8ab181", "#bc8db1", "#d9b572", "#76b5b4"],
		vizMuted: "#78746e",
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
