"use client";

import { useMemo, type CSSProperties } from "react";
import { usePaletteKey } from "@/components/color-scheme";
import { livePalette } from "@/components/theme-tokens";
import { SvgImage } from "@/components/artifacts/svg-image";
import { FIGURE, figurePalette, themeFigureSvg, type ColorScheme } from "@/src/core";

/**
 * Figure display in the house palette (design wave, docs/design.md). A
 * house SVG figure is re-colored by role for BOTH schemes and CSS picks one
 * by the page's .dark class, so the server paint is already right and a
 * mode flip needs no re-render. A custom background re-tints the surfaces
 * after load; the current scheme's variant then follows the live palette.
 * Anything that cannot be re-colored (other colors, rasters, Manim output)
 * is shown as drawn, on light paper, with the learner's invert switch.
 */

export type FigureVariants = Readonly<Record<ColorScheme, string>>;

export function useFigureVariants(svg: string | null): FigureVariants | null {
	const key = usePaletteKey();
	return useMemo(() => {
		if (svg === null) return null;
		const light = themeFigureSvg(svg, FIGURE.light);
		const dark = light === null ? null : themeFigureSvg(svg, FIGURE.dark);
		if (light === null || dark === null) return null;
		const [scheme, background] = key.split("|");
		if (!background || (scheme !== "light" && scheme !== "dark")) return { light, dark };
		const live = themeFigureSvg(svg, figurePalette(livePalette(scheme)));
		return live === null ? { light, dark } : { light, dark, [scheme]: live };
	}, [svg, key]);
}

/** Both variants; the hidden one stays out of layout and the a11y tree. */
export function ThemedSvgImage({
	variants,
	className = "",
	width,
}: {
	variants: FigureVariants;
	className?: string;
	width?: number;
}) {
	const base = className.replace(/(^|\s)block(?=\s|$)/g, " ").trim();
	return (
		<>
			<SvgImage svg={variants.light} width={width} className={`${base} block dark:hidden`.trim()} />
			<SvgImage svg={variants.dark} width={width} className={`${base} hidden dark:block`.trim()} />
		</>
	);
}

/** The backing of a figure shown as drawn: house light paper. The invert
 *  filter rides the same box, so the backing flips with the strokes. */
export function paperStyle(inverted: boolean): CSSProperties {
	return {
		backgroundColor: FIGURE.light.paper,
		filter: inverted ? "invert(1) hue-rotate(180deg)" : undefined,
	};
}
