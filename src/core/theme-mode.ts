/**
 * Light / dark / system — the pure half of the color-mode plumbing (design
 * wave, docs/design.md). The settings record stores the user's MODE; the
 * page renders a SCHEME. `system` resolves through prefers-color-scheme.
 *
 * Server-safe: the root layout inlines MODE_BOOT_SCRIPT into <head> so the
 * right scheme is on <html> before first paint (the settings record lives
 * behind /api/settings, too late to avoid a flash). The script reads the
 * mode the AppearanceProvider caches in localStorage after every load.
 */

import { PALETTE } from "./palette.ts";

export type AppearanceMode = "dark" | "light" | "system";
export type ColorScheme = "dark" | "light";

export const APPEARANCE_MODES: readonly AppearanceMode[] = ["dark", "light", "system"];

export function isAppearanceMode(value: unknown): value is AppearanceMode {
	return value === "dark" || value === "light" || value === "system";
}

export function resolveScheme(mode: AppearanceMode, systemDark: boolean): ColorScheme {
	if (mode === "system") return systemDark ? "dark" : "light";
	return mode;
}

/** localStorage key for the cached mode (boot script + provider). */
export const MODE_STORAGE_KEY = "cairn-mode";

/** Page surfaces per scheme — mirrors app/globals.css for the consumers
 *  that cannot read CSS (theme-color meta, the Electron title bar). */
export const SCHEME_SURFACES: Readonly<Record<ColorScheme, { background: string; foreground: string }>> = {
	dark: { background: PALETTE.dark.background, foreground: PALETTE.dark.foreground },
	light: { background: PALETTE.light.background, foreground: PALETTE.light.foreground },
};

/** Inline <head> script: cached mode → `dark` class + theme-color meta,
 *  before first paint. Unknown/absent cache keeps the server-rendered
 *  factory class. Never throws (storage can be blocked). */
export const MODE_BOOT_SCRIPT = `(function(){try{var m=localStorage.getItem(${JSON.stringify(MODE_STORAGE_KEY)});if(m!=="dark"&&m!=="light"&&m!=="system")return;var d=m==="dark"||(m==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;r.classList.toggle("dark",d);var s=${JSON.stringify(SCHEME_SURFACES)}[d?"dark":"light"];var t=document.querySelector('meta[name="theme-color"]');if(!t){t=document.createElement("meta");t.name="theme-color";document.head.appendChild(t);}t.content=s.background;}catch(e){}})();`;
