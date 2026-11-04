/**
 * Accessibility presets (M27). A preset is a named set of explicit values,
 * not a mode: turning one on writes its values into the settings sections,
 * where each stays editable on its own, and nothing records which preset
 * was turned on. A preset shows as on while the current values match every
 * value it writes, and turning it off returns those values to their
 * defaults.
 *
 * Pure and server-safe. The Accessibility page applies them
 * (components/settings/accessibility-section.tsx).
 */

import { resolveAccessibility } from "./accessibility.ts";
import {
	FACTORY_SETTINGS,
	type AccessibilitySettings,
	type AppearanceSettings,
	type GraphSettings,
} from "./settings.ts";

export type AccessibilityPresetId =
	| "low-vision"
	| "reading-comfort"
	| "reduce-motion"
	| "screen-reader"
	| "wcag-text-spacing";

export interface AccessibilityPreset {
	id: AccessibilityPresetId;
	name: string;
	hint: string;
	accessibility: AccessibilitySettings;
	appearance?: Pick<AppearanceSettings, "proseFontSize">;
	graph?: Pick<GraphSettings, "rendering">;
	/** Desktop zoom, set when the preset turns on. Zoom isn't stored, so it
	 *  isn't matched. */
	zoom?: number;
}

/** The page's presets, in order. WCAG text spacing sits under Advanced:
 *  it's a check of WCAG 1.4.12's minimums more than a way to read. */
export const ACCESSIBILITY_PRESETS: readonly AccessibilityPreset[] = [
	{
		id: "low-vision",
		name: "Low vision",
		hint: "High contrast, a thick focus outline, 20 px text with more space, and 125% zoom in the desktop app",
		accessibility: {
			contrast: "high",
			focus: "enhanced",
			lineHeight: 1.5,
			paragraphSpacing: 2.25,
			readingWidth: 80,
		},
		appearance: { proseFontSize: 20 },
		zoom: 1.25,
	},
	{
		id: "reading-comfort",
		name: "Reading comfort",
		hint: "More space between paragraphs, and lines of at most 80 characters",
		accessibility: { lineHeight: 1.5, paragraphSpacing: 2.25, readingWidth: 80 },
	},
	{
		id: "reduce-motion",
		name: "Reduce motion",
		hint: "Stops animations, slides and smooth scrolling",
		accessibility: { motion: "reduced" },
	},
	{
		id: "screen-reader",
		name: "Screen reader",
		hint: "Opens figure descriptions, announces long tool steps, and shows chains instead of the graph",
		accessibility: { expandDescriptions: true, announceToolSteps: true },
		graph: { rendering: false },
	},
	{
		id: "wcag-text-spacing",
		name: "WCAG text spacing",
		hint: "Line height 1.5×, paragraphs 2×, letters 0.12× and words 0.16× the text size (WCAG 1.4.12)",
		accessibility: { lineHeight: 1.5, paragraphSpacing: 2, letterSpacing: 0.12, wordSpacing: 0.16 },
	},
];

/** The stored deltas a preset reads and writes. */
export interface PresetSections {
	accessibility: AccessibilitySettings | undefined;
	appearance: AppearanceSettings | undefined;
	graph: GraphSettings | undefined;
	/** The desktop app's zoom factor, which isn't stored. Absent in the
	 *  browser. */
	zoom?: number;
}

/** What turning a preset on or off writes: each section it touches, whole.
 *  A section it doesn't touch is absent, and so is `zoom` when it leaves
 *  the zoom alone. */
export interface PresetWrites {
	accessibility: AccessibilitySettings;
	appearance?: AppearanceSettings;
	graph?: GraphSettings;
	/** The desktop zoom factor to set once the sections are written. */
	zoom?: number;
}

/** The desktop app's zoom at Actual size (⌘0). */
const DEFAULT_ZOOM = 1;

/** Zoom factors read back from Electron can miss the ladder's rung by a
 *  float's residue; the rungs are 0.1 or more apart. */
const sameZoom = (a: number, b: number) => Math.abs(a - b) < 0.005;

/** Turning a preset on writes each section it touches as the current delta
 *  with the preset's values over it, then its zoom. */
export function applyPreset(preset: AccessibilityPreset, current: PresetSections): PresetWrites {
	return {
		accessibility: { ...current.accessibility, ...preset.accessibility },
		...(preset.appearance ? { appearance: { ...current.appearance, ...preset.appearance } } : {}),
		...(preset.graph ? { graph: { ...current.graph, ...preset.graph } } : {}),
		...(preset.zoom !== undefined ? { zoom: preset.zoom } : {}),
	};
}

/** The delta without each field that holds the value `values` gives it, so
 *  the field falls back to its default. A field holding another value was
 *  changed since, and stays. */
function withoutValues<T extends object>(delta: T | undefined, values: Partial<T>): T {
	const next: Record<string, unknown> = { ...delta };
	for (const [field, value] of Object.entries(values)) {
		if (next[field] === value) delete next[field];
	}
	return next as T;
}

/** Turning a preset off writes each section it touches as the current
 *  delta without the preset's values, so each falls back to its default.
 *  The zoom returns to 100% while it's still the preset's; a zoom changed
 *  since with ⌘± stays. */
export function removePreset(preset: AccessibilityPreset, current: PresetSections): PresetWrites {
	const zoomed = preset.zoom !== undefined && current.zoom !== undefined && sameZoom(current.zoom, preset.zoom);
	return {
		accessibility: withoutValues(current.accessibility, preset.accessibility),
		...(preset.appearance ? { appearance: withoutValues(current.appearance, preset.appearance) } : {}),
		...(preset.graph ? { graph: withoutValues(current.graph, preset.graph) } : {}),
		...(zoomed ? { zoom: DEFAULT_ZOOM } : {}),
	};
}

/** Reset accessibility settings: the Accessibility section cleared, and
 *  every preset turned off outside it too, so a reading font size, Graph
 *  rendering or zoom holding a preset's value returns to its default,
 *  whichever page set it. Appearance and Graph are written only when that
 *  changes them. */
export function resetAccessibilitySettings(current: PresetSections): PresetWrites {
	let { appearance, graph } = current;
	let zoom: number | undefined;
	for (const preset of ACCESSIBILITY_PRESETS) {
		const off = removePreset(preset, { ...current, appearance, graph });
		appearance = off.appearance ?? appearance;
		graph = off.graph ?? graph;
		zoom ??= off.zoom;
	}
	// Turning presets off only removes fields, so a change is a lost key.
	const changed = (before: object | undefined, after: object | undefined) =>
		Object.keys(before ?? {}).length !== Object.keys(after ?? {}).length;
	return {
		accessibility: {},
		...(appearance && changed(current.appearance, appearance) ? { appearance } : {}),
		...(graph && changed(current.graph, graph) ? { graph } : {}),
		...(zoom !== undefined ? { zoom } : {}),
	};
}

/** True while every value the preset writes is the current value. An unset
 *  field counts as its default, so an absent line height matches 1.5. */
export function presetApplied(preset: AccessibilityPreset, current: PresetSections): boolean {
	const resolved = resolveAccessibility(current.accessibility);
	for (const [field, value] of Object.entries(preset.accessibility) as [keyof AccessibilitySettings, unknown][]) {
		if (resolved[field] !== value) return false;
	}
	const proseFontSize = preset.appearance?.proseFontSize;
	if (
		proseFontSize !== undefined &&
		(current.appearance?.proseFontSize ?? FACTORY_SETTINGS.appearance.proseFontSize) !== proseFontSize
	) {
		return false;
	}
	const rendering = preset.graph?.rendering;
	if (rendering !== undefined && (current.graph?.rendering ?? FACTORY_SETTINGS.graph.rendering) !== rendering) {
		return false;
	}
	return true;
}
