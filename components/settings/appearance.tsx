"use client";
/**
 * THE APPEARANCE APPLICATION (thin settings wave, 2026-09-19): the settings
 * record's appearance section actually DOES something — resolved against
 * the factory defaults and applied as RUNTIME CSS variables on <html>.
 *
 * Why variables and not className swaps: every seam the settings touch was
 * built token-first (--font-prose, --lh-prose-size, --lh-ink-strong, …),
 * so application is setProperty and nothing re-renders. The MODE is the
 * one class swap: light/dark/system resolves to a scheme and flips
 * <html class="dark"> (crossfaded via a view transition), caches the mode
 * for the next load's boot script (app/layout.tsx), and syncs the
 * theme-color meta + the desktop title bar. A custom background applies
 * only in the scheme it suits (backgroundScheme).
 *
 * The provider is mounted at the ROOT LAYOUT level (like ActivityProvider):
 * every page picks appearance up on load. The settings page writes a
 * section, hands the new appearance here, and the vars move immediately.
 *
 * (The open-settings keyboard chord lives in components/keyboard-shortcuts.tsx
 * with the other navigations — mod+, pushes /settings from anywhere.)
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
	FACTORY_SETTINGS,
	MODE_STORAGE_KEY,
	SCHEME_SURFACES,
	resolveScheme,
	type AppearanceMode,
	type AppearanceSettings,
	type ColorScheme,
} from "@/src/core";
import { currentScheme, useColorScheme, useSystemPrefersDark } from "@/components/color-scheme";
import { notifySettingsSaved } from "@/components/settings-signal";

/** The resolved, fully-concrete appearance view (delta + factory merged). */
export function resolveAppearance(delta: AppearanceSettings | undefined) {
	const f = FACTORY_SETTINGS.appearance;
	return {
		mode: delta?.mode ?? f.mode,
		background: delta?.background ?? f.background,
		fontFamily: delta?.fontFamily ?? f.fontFamily,
		proseFontSize: delta?.proseFontSize ?? f.proseFontSize,
		sessionNameSerif: delta?.sessionNameSerif ?? f.sessionNameSerif,
		mdRendering: {
			headingWeight: delta?.mdRendering?.headingWeight ?? f.mdRendering.headingWeight,
			boldColor: delta?.mdRendering?.boldColor ?? f.mdRendering.boldColor,
			italicColor: delta?.mdRendering?.italicColor ?? f.mdRendering.italicColor,
		},
	};
}

/** #rgb / #rrggbb → [r, g, b] (0–255). */
function channels(hex: string): [number, number, number] {
	const h = hex.length === 4 ? hex.slice(1).replace(/./g, (c) => c + c) : hex.slice(1, 7);
	return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** One channel shift, clamped to 0–255 (negative = darken). */
function shift(hex: string, add: number): string {
	return `#${channels(hex).map((c) => Math.max(0, Math.min(255, c + add)).toString(16).padStart(2, "0")).join("")}`;
}
/** Per-mode derivation curves (design wave): additive channel offsets that
 *  track the factory palettes in app/globals.css. Dark lifts every surface
 *  off the page (#0c121d → card #121823); light puts paper UP (+4) and
 *  hover/edges DOWN into the page. */
const CURVES: Readonly<Record<ColorScheme, { card: number; muted: number; accent: number; border: number; input: number }>> = {
	dark: { card: 6, muted: 13, accent: 19, border: 32, input: 42 },
	light: { card: 4, muted: -8, accent: -14, border: -24, input: -34 },
};

/** The derived palette a chosen background implies, on its mode's curve:
 *  background itself, raised paper (card/popover), the quiet fills
 *  (secondary/muted), hover (accent), the edges (border/input), and
 *  primary-foreground (text on the ink button = the page color). */
export function derivedPalette(background: string, scheme: ColorScheme = "dark"): Record<string, string> {
	const k = CURVES[scheme];
	const card = shift(background, k.card);
	const muted = shift(background, k.muted);
	return {
		"--background": background,
		"--card": card,
		"--popover": card,
		"--secondary": muted,
		"--muted": muted,
		"--accent": shift(background, k.accent),
		"--border": shift(background, k.border),
		"--input": shift(background, k.input),
		"--primary-foreground": background,
	};
}

/** Which mode a custom background belongs to (relative luminance against
 *  mid-gray). A dark background never lands under light-mode inks, and
 *  vice versa — the choice applies in the mode it suits. */
export function backgroundScheme(hex: string): ColorScheme {
	const [r, g, b] = channels(hex).map((c) => {
		const v = c / 255;
		return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.18 ? "dark" : "light";
}
/** THE mapping: resolved appearance → the CSS variables to set on <html>.
 *  Absent entries = leave the factory stylesheet value in place. Pure —
 *  exported for tests. */
export function appearanceVars(
	a: ReturnType<typeof resolveAppearance>,
	scheme: ColorScheme = "dark",
): Record<string, string> {
	const vars: Record<string, string> = {};
	if (a.background !== null && backgroundScheme(a.background) === scheme) {
		Object.assign(vars, derivedPalette(a.background, scheme));
	}
	if (a.fontFamily !== null) {
		vars["--font-prose"] = `"${a.fontFamily}", var(--font-sans3), ui-sans-serif, system-ui, sans-serif`;
	}
	// The ONE documented reading-size variable (typography round 4): prose,
	// inputs, and session titles all read it, so one setProperty moves them.
	vars["--lh-prose-size"] = `${a.proseFontSize}px`;
	// Session names: CMU Serif by default; the toggle swaps the title font
	// to the prose family — covers chat.tsx + new-session.tsx titles with
	// zero component edits (they use the .font-title utility).
	if (!a.sessionNameSerif) vars["--font-title"] = "var(--font-prose)";
	// Markdown rendering: heading weight + the emphasis inks (the vars
	// were built "ready for the settings UI").
	vars["--lh-heading-weight"] = String(a.mdRendering.headingWeight);
	if (a.mdRendering.boldColor !== null) vars["--lh-ink-strong"] = a.mdRendering.boldColor;
	if (a.mdRendering.italicColor !== null) vars["--lh-ink-italic"] = a.mdRendering.italicColor;
	return vars;
}

/** Pure: the previously-applied names ABSENT from the next var set —
 *  these get removeProperty so the factory stylesheet value returns.
 *  (Owner repro, fix wave: resets and toggle-backs never reverted because
 *  application only ever SET properties — the removal half was missing.)
 *  Exported for tests. */
export function staleVarNames(
	prevNames: readonly string[],
	nextVars: Record<string, string>,
): string[] {
	return prevNames.filter((n) => !(n in nextVars));
}

/** The desktop shell's optional chrome hook (electron/preload.cjs). */
type ShellBridge = { setTheme?: (scheme: ColorScheme) => void };

/** theme-color meta + the desktop title bar follow the page scheme. */
function syncSchemeChrome(scheme: ColorScheme) {
	let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
	if (!meta) {
		meta = document.createElement("meta");
		meta.name = "theme-color";
		document.head.appendChild(meta);
	}
	meta.content = SCHEME_SURFACES[scheme].background;
	(window as { lh?: ShellBridge }).lh?.setTheme?.(scheme);
}

/** Flip <html class="dark">. User-initiated flips crossfade through a view
 *  transition; the load-time reconcile and reduced-motion users snap. */
function applyScheme(target: ColorScheme, animate: boolean) {
	if (currentScheme() === target) {
		syncSchemeChrome(target);
		return;
	}
	const flip = () => {
		document.documentElement.classList.toggle("dark", target === "dark");
		syncSchemeChrome(target);
	};
	const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
	const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	if (animate && !reduce && typeof doc.startViewTransition === "function") doc.startViewTransition(flip);
	else flip();
}

interface AppearanceContextValue {
	/** Resolved appearance; factory until the record arrives. */
	appearance: ReturnType<typeof resolveAppearance>;
	/** The scheme on screen right now (system mode already resolved). */
	scheme: ColorScheme;
	/** True once the stored record has loaded — quick toggles wait for it so
	 *  a write never drops the record's other appearance fields. */
	ready: boolean;
	/** Called by the settings page after a successful section PUT. */
	onAppearanceChange: (delta: AppearanceSettings | undefined) => void;
	/** Quick switch (sidebar): writes the appearance section with a new mode. */
	setMode: (mode: AppearanceMode) => void;
}

const AppearanceContext = createContext<AppearanceContextValue>({
	appearance: resolveAppearance(undefined),
	scheme: "dark",
	ready: false,
	onAppearanceChange: () => {},
	setMode: () => {},
});

export function useAppearance() {
	return useContext(AppearanceContext);
}

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
	const [delta, setDelta] = useState<AppearanceSettings | undefined>(undefined);
	const [ready, setReady] = useState(false);
	const appliedRef = useRef<string>("");
	const scheme = useColorScheme();
	const systemDark = useSystemPrefersDark();
	const resolved = useMemo(() => resolveAppearance(delta), [delta]);

	// The vars apply on every change — stringified as the change signal.
	const vars = useMemo(() => appearanceVars(resolved, scheme), [resolved, scheme]);
	const key = useMemo(() => JSON.stringify(vars), [vars]);
	// REMOVAL is half the job (owner repro, fix wave): a later write that
	// OMITS a var (empty field = factory, serif toggle back on) must clear
	// the previously-set inline value or the stale one wins forever —
	// backgrounds never reset, toggles looked dead. Every name this effect
	// has ever set is tracked; names absent from the new set are removed so
	// the factory stylesheet value returns.
	const appliedNamesRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		if (appliedRef.current === key) return;
		appliedRef.current = key;
		const root = document.documentElement;
		for (const name of staleVarNames([...appliedNamesRef.current], vars)) {
			root.style.removeProperty(name);
			appliedNamesRef.current.delete(name);
		}
		for (const [name, value] of Object.entries(vars)) {
			root.style.setProperty(name, value);
			appliedNamesRef.current.add(name);
		}
	}, [key, vars]);

	// THE MODE waits for the record: until it lands, the boot script's
	// cached mode stands (applying the factory "dark" first would flash a
	// light-mode user). The first reconcile snaps; later changes crossfade.
	const mode = resolved.mode;
	const reconciledRef = useRef(false);
	useEffect(() => {
		if (!ready) return;
		applyScheme(resolveScheme(mode, systemDark), reconciledRef.current);
		reconciledRef.current = true;
		try {
			localStorage.setItem(MODE_STORAGE_KEY, mode);
		} catch {
			/* storage blocked — the next load just starts at the factory */
		}
	}, [ready, mode, systemDark]);

	// One fetch per app load: the record (sanitized server-side) carries the
	// delta; resolution happens here against the compiled factory.
	useEffect(() => {
		let alive = true;
		fetch("/api/settings")
			.then((r) => r.json())
			.then((body: { settings?: Record<string, unknown> }) => {
				if (!alive) return;
				// The record arrives sanitized server-side; the appearance
				// slice is unknown-shaped here, so it goes through the same
				// resolve (absent/invalid fields = factory anyway).
				const appearance = body.settings?.appearance;
				setDelta(
					appearance && typeof appearance === "object" ? (appearance as AppearanceSettings) : undefined,
				);
				setReady(true);
			})
			.catch(() => {/* settings stay factory — not worth a crash */});
		return () => {
			alive = false;
		};
	}, []);

	const onAppearanceChange = useCallback((next: AppearanceSettings | undefined) => {
		setDelta(next);
	}, []);

	// The quick switch PUTs the WHOLE section (the route replaces it), so it
	// reads the latest delta through a ref rather than a stale closure.
	const deltaRef = useRef<AppearanceSettings | undefined>(undefined);
	useEffect(() => {
		deltaRef.current = delta;
	}, [delta]);
	const setMode = useCallback((next: AppearanceMode) => {
		const body: AppearanceSettings = { ...(deltaRef.current ?? {}), mode: next };
		deltaRef.current = body;
		setDelta(body);
		void fetch("/api/settings/appearance", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		})
			.then((res) => {
				if (res.ok) notifySettingsSaved("appearance");
			})
			.catch(() => {/* the switch still applied for this session */});
	}, []);

	const value = useMemo(
		() => ({ appearance: resolved, scheme, ready, onAppearanceChange, setMode }),
		[resolved, scheme, ready, onAppearanceChange, setMode],
	);
	return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}