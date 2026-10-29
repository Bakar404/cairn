/**
 * Live token reads for the painters that live outside CSS (design wave):
 * the graph canvas and Mermaid resolve the page's CURRENT palette — a
 * custom background included — and fall back to the static table
 * (src/core/palette.ts) wherever no DOM or 2D canvas exists (SSR, tests).
 */

import { PALETTE, PALETTE_VARS, VIZ_VARS, type ColorScheme, type SchemePalette } from "@/src/core";

const HEX = /^#[0-9a-f]{6}$/i;

/** Any CSS color → `#rrggbb` (hex passes through; anything else takes a
 *  1px canvas round-trip). Null for a non-color, or when there is no 2D
 *  canvas to ask. */
export function cssColorToHex(css: string): string | null {
	const value = css.trim();
	if (HEX.test(value)) return value.toLowerCase();
	if (!value || typeof document === "undefined") return null;
	// An invalid fillStyle is silently ignored, which would read back black.
	if (typeof CSS !== "undefined" && !CSS.supports("color", value)) return null;
	const canvas = document.createElement("canvas");
	canvas.width = 1;
	canvas.height = 1;
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;
	ctx.fillStyle = value;
	ctx.fillRect(0, 0, 1, 1);
	const { data } = ctx.getImageData(0, 0, 1, 1);
	return `#${[data[0]!, data[1]!, data[2]!].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** One token as `<html>` resolves it now; `fallback` when unreadable. */
export function tokenHex(cssVar: string, fallback: string): string {
	if (typeof document === "undefined") return fallback;
	const value = getComputedStyle(document.documentElement).getPropertyValue(cssVar);
	return cssColorToHex(value) ?? fallback;
}

/** The whole palette as the page shows it right now. */
export function livePalette(scheme: ColorScheme): SchemePalette {
	const base = PALETTE[scheme];
	const scalars = Object.fromEntries(
		(Object.keys(PALETTE_VARS) as (keyof typeof PALETTE_VARS)[]).map((key) => [key, tokenHex(PALETTE_VARS[key], base[key])]),
	) as Omit<SchemePalette, "viz">;
	const viz = VIZ_VARS.map((v, i) => tokenHex(v, base.viz[i]!)) as unknown as SchemePalette["viz"];
	return { ...scalars, viz };
}
