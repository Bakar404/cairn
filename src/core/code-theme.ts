/**
 * THE CODE PALETTE (design wave, docs/design.md): the two Shiki themes
 * every highlighted code block renders with (chat, reasoning), built from
 * the app palette so code reads as part of the page instead of GitHub's
 * blue/purple/red on warm stone. Mostly ink; five data hues carry the
 * token classes, each moved toward the ink only as far as it takes to
 * clear AA on the code surface; diffs use the semantic colors. No brand
 * clay — syntax is data, not the accent. Streamdown paints both sets on
 * every token and the .dark class picks one, so a mode flip needs no
 * re-highlight.
 */

import { PALETTE, contrastRatio, mixHex, type SchemePalette } from "./palette.ts";
import type { ColorScheme } from "./theme-mode.ts";

/** A TextMate theme in the shape Shiki registers (structurally its
 *  ThemeRegistration; src/core stays free of the shiki types). */
export interface CodeTheme {
	name: string;
	type: ColorScheme;
	fg: string;
	bg: string;
	colors: Record<string, string>;
	tokenColors: { scope: string[]; settings: { foreground?: string; fontStyle?: string } }[];
}

/** globals.css --code-surface as sRGB hex: a step INTO the page — 5% ink
 *  on light paper, 14% black under dark. */
export function codeSurface(scheme: ColorScheme, p: SchemePalette = PALETTE[scheme]): string {
	return scheme === "light" ? mixHex(p.background, p.foreground, 0.05) : mixHex(p.background, "#000000", 0.14);
}

/** `hex` moved toward `ink` in 5% steps until it clears `min` on every
 *  surface: the hue stays, only its lightness gives way. */
export function readableOn(hex: string, ink: string, surfaces: readonly string[], min = 4.5): string {
	for (let step = 0; step <= 20; step++) {
		const c = mixHex(hex, ink, step / 20);
		if (surfaces.every((s) => contrastRatio(c, s) >= min)) return c;
	}
	return ink;
}

export function codeTheme(scheme: ColorScheme, p: SchemePalette = PALETTE[scheme]): CodeTheme {
	// Code renders on the code surface; page and card cover any host that
	// drops it.
	const surfaces = [codeSurface(scheme, p), p.background, p.card];
	const ink = (hex: string) => readableOn(hex, p.foreground, surfaces);
	const [terracotta, slate, sage, plum, ochre, teal] = p.viz.map(ink) as [string, string, string, string, string, string];
	const comment = ink(p.mutedForeground);
	const rule = (foreground: string | undefined, scope: string[], fontStyle?: string) => ({
		scope,
		settings: { ...(foreground ? { foreground } : {}), ...(fontStyle ? { fontStyle } : {}) },
	});
	return {
		name: `cairn-${scheme}`,
		type: scheme,
		fg: p.foreground,
		// Transparent: the house --code-surface paints the block (globals.css).
		bg: "#00000000",
		colors: { "editor.foreground": p.foreground, "editor.background": "#00000000" },
		tokenColors: [
			rule(comment, ["comment", "punctuation.definition.comment", "string.comment"], "italic"),
			rule(mixHex(p.foreground, comment, 0.5), ["punctuation", "meta.brace", "keyword.operator"]),
			rule(plum, [
				"keyword", "storage", "storage.type", "storage.modifier", "keyword.control",
				"keyword.operator.new", "keyword.operator.expression", "keyword.operator.word",
				"keyword.operator.logical.python", "keyword.operator.wordlike", "variable.language",
				"punctuation.definition.template-expression",
			]),
			rule(sage, ["string", "punctuation.definition.string", "string.quoted", "string.template"]),
			rule(p.foreground, ["meta.template.expression", "variable.parameter", "variable.other"]),
			rule(ochre, [
				"constant.numeric", "constant.language", "constant.character", "constant.other",
				"support.constant", "entity.other.attribute-name", "meta.decorator",
				"entity.name.function.decorator", "punctuation.decorator",
			]),
			rule(slate, [
				"entity.name.function", "support.function", "variable.function", "meta.function-call.generic",
				"support.type.property-name", "meta.object-literal.key", "entity.name.tag.yaml",
				"markup.underline.link", "string.other.link",
			]),
			rule(teal, [
				"entity.name.type", "entity.name.class", "entity.other.inherited-class", "entity.name.namespace",
				"support.type", "support.class", "storage.type.primitive",
			]),
			rule(terracotta, ["entity.name.tag", "string.regexp", "markup.inline.raw"]),
			rule(ink(p.success), ["markup.inserted", "punctuation.definition.inserted"]),
			rule(ink(p.danger), ["markup.deleted", "punctuation.definition.deleted", "invalid", "invalid.illegal"]),
			rule(ink(p.warning), ["markup.changed", "punctuation.definition.changed"]),
			rule(comment, ["meta.diff.header", "meta.diff.range", "markup.quote"], "italic"),
			rule(p.foreground, ["markup.heading", "entity.name.section", "markup.bold"], "bold"),
			rule(undefined, ["markup.italic"], "italic"),
		],
	};
}

export const CODE_THEME: Readonly<Record<ColorScheme, CodeTheme>> = {
	light: codeTheme("light"),
	dark: codeTheme("dark"),
};
