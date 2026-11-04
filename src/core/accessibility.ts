/**
 * Accessibility mode (M27), the pure half: the preference types, the
 * reading-comfort ranges, resolution against the defaults, and what a
 * resolved section puts on <html> — four attributes and the reading
 * variables — plus the data-os-* attributes that report the OS as it is.
 *
 * The settings record (the accessibility section, settings.ts) stores
 * PREFERENCES. Two of them follow the OS: motion "system" reads
 * prefers-reduced-motion, and followSystem raises contrast and reduces
 * transparency when the OS asks for that. So the attributes come from the
 * preferences plus live media (and, on desktop, Electron's nativeTheme)
 * and are never stored.
 *
 * Server-safe: the root layout inlines A11Y_BOOT_SCRIPT into <head>, after
 * the mode script, so the attributes and variables are on <html> before
 * first paint. The script reads the state the AccessibilityProvider caches
 * in localStorage after every load (components/settings/accessibility.tsx).
 * settings.ts imports from this module, so it imports nothing back.
 */

export type ContrastPreference = "standard" | "high";
export type MotionPreference = "system" | "reduced" | "full";
export type FocusIndicator = "standard" | "enhanced";

export const CONTRAST_PREFERENCES: readonly ContrastPreference[] = ["standard", "high"];
export const MOTION_PREFERENCES: readonly MotionPreference[] = ["system", "reduced", "full"];
export const FOCUS_INDICATORS: readonly FocusIndicator[] = ["standard", "enhanced"];

export function isContrastPreference(value: unknown): value is ContrastPreference {
	return value === "standard" || value === "high";
}

export function isMotionPreference(value: unknown): value is MotionPreference {
	return value === "system" || value === "reduced" || value === "full";
}

export function isFocusIndicator(value: unknown): value is FocusIndicator {
	return value === "standard" || value === "enhanced";
}

/** The reading-comfort numbers, each an inclusive range walked in steps
 *  from its minimum. Spacing is in em, so it scales with the reading size;
 *  the reading width is in ch. */
export const A11Y_RANGES = {
	lineHeight: { min: 1, max: 2, step: 0.05 },
	paragraphSpacing: { min: 0, max: 2.5, step: 0.05 },
	letterSpacing: { min: 0, max: 0.5, step: 0.01 },
	wordSpacing: { min: 0, max: 1, step: 0.01 },
	readingWidth: { min: 45, max: 90, step: 5 },
} as const;

export type A11yRangeField = keyof typeof A11Y_RANGES;

/** Clamps `value` into the field's range and rounds it to the nearest step,
 *  with no float residue: lineHeight 1.53 → 1.55, readingWidth 200 → 90. */
export function snapToRange(field: A11yRangeField, value: number): number {
	const { min, max, step } = A11Y_RANGES[field];
	const decimals = (String(step).split(".")[1] ?? "").length;
	const clamped = Math.min(Math.max(value, min), max);
	const snapped = Number((min + Math.round((clamped - min) / step) * step).toFixed(decimals));
	return Math.min(Math.max(snapped, min), max);
}

/** True when `value` is inside the field's range and on one of its steps. */
export function isOnStep(field: A11yRangeField, value: number): boolean {
	const { min, max } = A11Y_RANGES[field];
	if (!Number.isFinite(value) || value < min || value > max) return false;
	return Math.abs(snapToRange(field, value) - value) < 1e-9;
}

/** The section with every field concrete. A null number is "not set": the
 *  stylesheet's own spacing or width stands. */
export interface ResolvedAccessibility {
	followSystem: boolean;
	contrast: ContrastPreference;
	motion: MotionPreference;
	focus: FocusIndicator;
	lineHeight: number;
	paragraphSpacing: number | null;
	letterSpacing: number | null;
	wordSpacing: number | null;
	readingWidth: number | null;
	expandDescriptions: boolean;
	announceToolSteps: boolean;
}

export const ACCESSIBILITY_DEFAULTS: Readonly<ResolvedAccessibility> = {
	followSystem: true,
	contrast: "standard",
	motion: "system",
	focus: "standard",
	lineHeight: 1.5,
	paragraphSpacing: null,
	letterSpacing: null,
	wordSpacing: null,
	readingWidth: null,
	expandDescriptions: false,
	announceToolSteps: false,
};

/** Any value (the record's section, a cache) → the resolved section. Each
 *  field is checked on its own: a missing or invalid one takes its default,
 *  and an out-of-range number snaps into range. Never throws. */
export function resolveAccessibility(delta: unknown): ResolvedAccessibility {
	const d =
		delta !== null && typeof delta === "object" && !Array.isArray(delta) ? (delta as Record<string, unknown>) : {};
	const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
	const num = (field: A11yRangeField) => {
		const value = d[field];
		return typeof value === "number" && Number.isFinite(value) ? snapToRange(field, value) : null;
	};
	const D = ACCESSIBILITY_DEFAULTS;
	return {
		followSystem: bool(d.followSystem, D.followSystem),
		contrast: isContrastPreference(d.contrast) ? d.contrast : D.contrast,
		motion: isMotionPreference(d.motion) ? d.motion : D.motion,
		focus: isFocusIndicator(d.focus) ? d.focus : D.focus,
		lineHeight: num("lineHeight") ?? D.lineHeight,
		paragraphSpacing: num("paragraphSpacing"),
		letterSpacing: num("letterSpacing"),
		wordSpacing: num("wordSpacing"),
		readingWidth: num("readingWidth"),
		expandDescriptions: bool(d.expandDescriptions, D.expandDescriptions),
		announceToolSteps: bool(d.announceToolSteps, D.announceToolSteps),
	};
}

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
export const MORE_CONTRAST_QUERY = "(prefers-contrast: more)";
export const REDUCED_TRANSPARENCY_QUERY = "(prefers-reduced-transparency: reduce)";
export const FORCED_COLORS_QUERY = "(forced-colors: active)";

/** The OS signals the browser reports, one per media query above. */
export interface AccessibilityMedia {
	reducedMotion: boolean;
	moreContrast: boolean;
	reducedTransparency: boolean;
	forcedColors: boolean;
}

/** The desktop app's read of the OS: Electron's nativeTheme, sent over the
 *  preload bridge (electron/main.cjs). Inverted colors and "Differentiate
 *  without color" have no media query at all. */
export interface SystemAccessibility {
	highContrast: boolean;
	forcedColors: boolean;
	invertedColors: boolean;
	reducedTransparency: boolean;
	differentiateWithoutColor: boolean;
}

/** A bridge payload → the five flags, each true only when it's exactly
 *  true. Null when the payload isn't an object (no bridge, an older app). */
export function systemAccessibility(value: unknown): SystemAccessibility | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const v = value as Record<string, unknown>;
	return {
		highContrast: v.highContrast === true,
		forcedColors: v.forcedColors === true,
		invertedColors: v.invertedColors === true,
		reducedTransparency: v.reducedTransparency === true,
		differentiateWithoutColor: v.differentiateWithoutColor === true,
	};
}

/** Both sources merged: the OS asks for a thing when either source says so. */
export interface OsAccessibility extends AccessibilityMedia {
	invertedColors: boolean;
	differentiateWithoutColor: boolean;
}

export function osAccessibility(media: AccessibilityMedia, system: SystemAccessibility | null): OsAccessibility {
	return {
		reducedMotion: media.reducedMotion,
		moreContrast: media.moreContrast || system?.highContrast === true,
		reducedTransparency: media.reducedTransparency || system?.reducedTransparency === true,
		forcedColors: media.forcedColors || system?.forcedColors === true,
		invertedColors: system?.invertedColors === true,
		differentiateWithoutColor: system?.differentiateWithoutColor === true,
	};
}

/** The <html> attribute each effective value goes on. */
export const A11Y_ATTRIBUTES = {
	focus: "data-focus",
	motion: "data-motion",
	contrast: "data-contrast",
	transparency: "data-transparency",
} as const;

export interface AccessibilityAttributes {
	focus: FocusIndicator;
	motion: "reduced" | "full";
	contrast: ContrastPreference;
	transparency: "reduced" | "standard";
}

/** The effective values: motion "system" follows the OS; contrast is high
 *  when chosen, or when following the system and the OS asks for more; and
 *  transparency is reduced only when following the system and the OS asks.
 *  Forced colors need nothing here: the browser applies them regardless. */
export function accessibilityAttributes(
	a: ResolvedAccessibility,
	os: Pick<AccessibilityMedia, "reducedMotion" | "moreContrast" | "reducedTransparency">,
): AccessibilityAttributes {
	return {
		focus: a.focus,
		motion: a.motion === "system" ? (os.reducedMotion ? "reduced" : "full") : a.motion,
		contrast: a.contrast === "high" || (a.followSystem && os.moreContrast) ? "high" : "standard",
		transparency: a.followSystem && os.reducedTransparency ? "reduced" : "standard",
	};
}

/** The <html> attributes that report the OS as it is, whatever the settings
 *  say, in the media-feature vocabulary. Only the provider sets them: the
 *  desktop's half arrives over the bridge after first paint. */
export const OS_ATTRIBUTES = {
	contrast: "data-os-contrast",
	transparency: "data-os-transparency",
	forcedColors: "data-os-forced-colors",
	inverted: "data-os-inverted",
	differentiate: "data-os-differentiate",
} as const;

export interface OsAttributes {
	contrast: "more" | "no-preference";
	transparency: "reduce" | "no-preference";
	forcedColors: "active" | "none";
	inverted: "inverted" | "none";
	differentiate: "without-color" | "no-preference";
}

export function osAttributes(os: OsAccessibility): OsAttributes {
	return {
		contrast: os.moreContrast ? "more" : "no-preference",
		transparency: os.reducedTransparency ? "reduce" : "no-preference",
		forcedColors: os.forcedColors ? "active" : "none",
		inverted: os.invertedColors ? "inverted" : "none",
		differentiate: os.differentiateWithoutColor ? "without-color" : "no-preference",
	};
}

/** Every variable accessibilityVars can set; the boot script applies these
 *  names and no others. */
export const A11Y_VAR_NAMES = [
	"--lh-prose-leading",
	"--lh-paragraph-spacing",
	"--lh-letter-spacing",
	"--lh-word-spacing",
	"--lh-reading-width",
] as const;

/** Resolved section → the CSS variables to set on <html>. A number that
 *  isn't set has no entry, so the stylesheet's value stands. */
export function accessibilityVars(a: ResolvedAccessibility): Record<string, string> {
	const vars: Record<string, string> = { "--lh-prose-leading": String(a.lineHeight) };
	if (a.paragraphSpacing !== null) vars["--lh-paragraph-spacing"] = `${a.paragraphSpacing}em`;
	if (a.letterSpacing !== null) vars["--lh-letter-spacing"] = `${a.letterSpacing}em`;
	if (a.wordSpacing !== null) vars["--lh-word-spacing"] = `${a.wordSpacing}em`;
	if (a.readingWidth !== null) vars["--lh-reading-width"] = `${a.readingWidth}ch`;
	return vars;
}

/** localStorage key for the boot script's cache. */
export const A11Y_STORAGE_KEY = "cairn-a11y";

/** The cached state: the preferences the attributes come from (the boot
 *  script reads the media fresh) and the finished variables. */
export interface AccessibilityCache {
	focus: FocusIndicator;
	motion: MotionPreference;
	contrast: ContrastPreference;
	followSystem: boolean;
	vars: Record<string, string>;
}

export function accessibilityCache(a: ResolvedAccessibility): AccessibilityCache {
	return {
		focus: a.focus,
		motion: a.motion,
		contrast: a.contrast,
		followSystem: a.followSystem,
		vars: accessibilityVars(a),
	};
}

/** Inline <head> script: the cache and the OS media → the attributes and
 *  variables, before first paint. With no cache, or a broken one, each
 *  attribute still gets its default value; the variables wait for the
 *  provider, and so do the data-os-* attributes. Only A11Y_VAR_NAMES are
 *  applied. Never throws (storage can be blocked). */
export const A11Y_BOOT_SCRIPT = `(function(){try{var c={};try{var s=localStorage.getItem(${JSON.stringify(A11Y_STORAGE_KEY)});var p=s?JSON.parse(s):null;if(p&&typeof p==="object")c=p;}catch(e){}var q=function(m){try{return matchMedia(m).matches===true;}catch(e){return false;}};var r=document.documentElement,a=${JSON.stringify(A11Y_ATTRIBUTES)},f=c.followSystem!==false;r.setAttribute(a.focus,c.focus==="enhanced"?"enhanced":"standard");r.setAttribute(a.motion,c.motion==="reduced"||c.motion==="full"?c.motion:q(${JSON.stringify(REDUCED_MOTION_QUERY)})?"reduced":"full");r.setAttribute(a.contrast,c.contrast==="high"||(f&&q(${JSON.stringify(MORE_CONTRAST_QUERY)}))?"high":"standard");r.setAttribute(a.transparency,f&&q(${JSON.stringify(REDUCED_TRANSPARENCY_QUERY)})?"reduced":"standard");var v=c.vars,n=${JSON.stringify(A11Y_VAR_NAMES)};if(v&&typeof v==="object"){for(var i=0;i<n.length;i++){if(Object.prototype.hasOwnProperty.call(v,n[i])&&typeof v[n[i]]==="string")r.style.setProperty(n[i],v[n[i]]);}}}catch(e){}})();`;
