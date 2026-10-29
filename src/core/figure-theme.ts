/**
 * THE FIGURE PALETTE (design wave, docs/design.md): the six named colors
 * every generated figure draws with (SVG visuals, Manim stills, Manim
 * animations), taken from the app palette so a figure reads as part of
 * the page it sits on. Generators always draw with the LIGHT set: a raster
 * cannot change after it renders. An SVG figure can, so the figure card
 * re-colors it BY ROLE for the page's scheme when every color in it is a
 * figure color (themeFigureSvg); anything else keeps the paper backing and
 * the manual invert switch.
 */

import { PALETTE, mixHex, type SchemePalette } from "./palette.ts";
import type { ColorScheme } from "./theme-mode.ts";

export const FIGURE_ROLES = ["paper", "ink", "muted", "faint", "accent", "accent2"] as const;
export type FigureRole = (typeof FIGURE_ROLES)[number];
export type FigurePalette = Readonly<Record<FigureRole, string>>;

/** The figure roles of one app palette: paper is the card surface, the
 *  accent is the brand cobalt and the second accent the second data hue
 *  (orange, its complement). */
export function figurePalette(p: SchemePalette): FigurePalette {
	return {
		paper: p.card,
		ink: p.foreground,
		muted: p.mutedForeground,
		faint: p.border,
		accent: p.brand,
		accent2: p.viz[1],
	};
}

export const FIGURE: Readonly<Record<ColorScheme, FigurePalette>> = {
	light: figurePalette(PALETTE.light),
	dark: figurePalette(PALETTE.dark),
};

/** The fixed palette figures were drawn with before the design wave; the
 *  card maps it by role too, so older figures join the house look. */
export const LEGACY_FIGURE: FigurePalette = {
	paper: "#ffffff",
	ink: "#1f1f1f",
	muted: "#6b6b6b",
	faint: "#d9d9d9",
	accent: "#2563eb",
	accent2: "#ea580c",
};

/** The warm-stone house palette (design wave, until Ink & Paper): figures
 *  drawn with it still map by role, like the legacy set. */
export const STONE_FIGURE: Readonly<Record<ColorScheme, FigurePalette>> = {
	light: { paper: "#fcfbf9", ink: "#211e19", muted: "#69645c", faint: "#e0dcd5", accent: "#ab532f", accent2: "#5377a0" },
	dark: { paper: "#191816", ink: "#e9e6e0", muted: "#9f9b93", faint: "#33302c", accent: "#db8862", accent2: "#7fa2c9" },
};

const ROLE_OF: ReadonlyMap<string, FigureRole> = (() => {
	const map = new Map<string, FigureRole>();
	for (const set of [LEGACY_FIGURE, STONE_FIGURE.dark, STONE_FIGURE.light, FIGURE.dark, FIGURE.light]) {
		for (const role of FIGURE_ROLES) map.set(set[role], role);
	}
	for (const [name, role] of [["#fff", "paper"], ["white", "paper"], ["#000", "ink"], ["#000000", "ink"], ["black", "ink"]] as const) {
		map.set(name, role);
	}
	return map;
})();

const NAMED_GREYS: ReadonlyMap<string, string> = new Map([
	["gray", "#808080"], ["grey", "#808080"], ["silver", "#c0c0c0"], ["lightgray", "#d3d3d3"],
	["lightgrey", "#d3d3d3"], ["darkgray", "#a9a9a9"], ["darkgrey", "#a9a9a9"], ["dimgray", "#696969"],
	["dimgrey", "#696969"], ["gainsboro", "#dcdcdc"], ["whitesmoke", "#f5f5f5"],
]);

/** The channel value of a pure grey `#rgb`/`#rrggbb`, else null. */
function greyLevel(hex: string): number | null {
	const h = hex.toLowerCase();
	const six = /^#[0-9a-f]{3}$/.test(h) ? `#${h.slice(1, 2).repeat(2)}${h.slice(2, 3).repeat(2)}${h.slice(3, 4).repeat(2)}` : h;
	if (!/^#[0-9a-f]{6}$/.test(six)) return null;
	const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(six.slice(i, i + 2), 16));
	return r === g && g === b ? (r ?? null) : null;
}

/** A known figure color → its role in the target; any other pure grey →
 *  the same depth on the target's paper→ink ramp. Null otherwise. */
function mapColor(color: string, target: FigurePalette): string | null {
	const c = color.toLowerCase();
	const role = ROLE_OF.get(c);
	if (role) return target[role];
	const level = greyLevel(NAMED_GREYS.get(c) ?? c);
	return level === null ? null : mixHex(target.paper, target.ink, 1 - level / 255);
}

const COLOR_ATTRS = new Set(["fill", "stroke", "stop-color", "flood-color", "lighting-color", "color"]);
const CSS_COLOR_DECL = /(^|[;{\s])(fill|stroke|stop-color|flood-color|lighting-color|color|background-color|background)(\s*:\s*)([^;}]*)/gi;
const KEYWORDS = new Set(["", "none", "transparent", "currentcolor", "inherit", "initial", "unset"]);
// Raster content, embedded HTML, script and color animation cannot be re-colored by role.
const UNTHEMABLE = /<(?:image|foreignObject|script|animate|animateColor|set)(?=[\s/>])/i;
const FUNCTIONAL = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/i;
// Any #-run in CSS that is not a url() reference; lengths other than 3/6 are refused.
const CSS_HEX = /(?<!url\(\s*['"]?)#[0-9a-f]+(?![\w-])/gi;
const TOKEN = /<!--[\s\S]*?(?:-->|$)|<\?[\s\S]*?(?:\?>|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|(<style\b(?:[^<>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/style\s*>|$)|<[a-zA-Z](?:[^<>"']|"[^"]*"|'[^']*')*>/g;
const ATTR = /(\s)([^\s=/>]+)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

/**
 * Re-color a figure SVG for a target palette, role by role (pure greys
 * keep their depth on the paper→ink ramp). Null when any color in it is
 * neither a known figure color (house light/dark, the legacy set,
 * white/black) nor a grey, or the SVG holds content that cannot be
 * mapped: the caller then shows the original on paper. Text content is
 * never touched. The root also gets the target ink as its default fill and
 * color, so shapes that rely on the black default stay visible on dark
 * paper. Pure.
 */
export function themeFigureSvg(svg: string, target: FigurePalette): string | null {
	if (UNTHEMABLE.test(svg)) return null;
	let pure = true;
	const mapHex = (hex: string): string => {
		const mapped = mapColor(hex, target);
		if (mapped === null) {
			pure = false;
			return hex;
		}
		return mapped;
	};
	const mapValue = (raw: string): string => {
		const value = raw.trim().toLowerCase();
		if (KEYWORDS.has(value) || value.startsWith("url(")) return raw;
		const mapped = mapColor(value, target);
		if (mapped !== null) return mapped;
		pure = false;
		return raw;
	};
	const mapCss = (css: string): string => {
		if (FUNCTIONAL.test(css)) {
			pure = false;
			return css;
		}
		const hexed = css.replace(CSS_HEX, mapHex);
		return hexed.replace(CSS_COLOR_DECL, (_m, lead: string, prop: string, colon: string, value: string) => {
			const bare = value.replace(/!important\s*$/i, "").trim();
			if (bare.startsWith("#") || bare.toLowerCase().startsWith("url(")) return `${lead}${prop}${colon}${value}`;
			return `${lead}${prop}${colon}${value.replace(bare, mapValue(bare))}`;
		});
	};
	let rootSeen = false;
	const mapTag = (tag: string): string => {
		const names = new Set<string>();
		let out = tag.replace(ATTR, (m, space: string, name: string, eq: string, dq?: string, sq?: string, bare?: string) => {
			const key = name.toLowerCase();
			names.add(key);
			const value = dq ?? sq ?? bare ?? "";
			let next: string;
			if (COLOR_ATTRS.has(key)) next = mapValue(value);
			else if (key === "style") next = mapCss(value);
			else return m;
			const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : '"';
			return `${space}${name}${eq}${quote}${next}${quote}`;
		});
		if (!rootSeen && /^<svg(?=[\s/>])/i.test(out)) {
			rootSeen = true;
			const style = /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(out);
			const styled = style ? (style[1] ?? style[2] ?? "") : "";
			const extra = [
				names.has("fill") || /(^|;)\s*fill\s*:/i.test(styled) ? "" : ` fill="${target.ink}"`,
				names.has("color") || /(^|;)\s*color\s*:/i.test(styled) ? "" : ` color="${target.ink}"`,
			].join("");
			out = out.replace(/^<svg/i, `$&${extra}`);
		}
		return out;
	};
	const out = svg.replace(TOKEN, (token: string, styleOpen?: string, css?: string, styleClose?: string) => {
		if (styleOpen !== undefined) return `${mapTag(styleOpen)}${mapCss(css ?? "")}${styleClose ?? ""}`;
		if (token.startsWith("<!--") || token.startsWith("<?") || token.startsWith("<![CDATA[")) return token;
		return mapTag(token);
	});
	return pure && rootSeen ? out : null;
}
