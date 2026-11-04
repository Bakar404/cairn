"use client";
/**
 * Accessibility mode (M27), the live half. The AccessibilityProvider puts
 * the record's accessibility section on <html>: the data-focus, data-motion,
 * data-contrast and data-transparency attributes and the reading variables,
 * all mapped in src/core/accessibility.ts. After each apply it caches the
 * section for the next load's boot script (A11Y_BOOT_SCRIPT in
 * app/layout.tsx).
 *
 * Nothing applies until the record arrives. The boot script has already
 * painted the cached state, and applying the defaults first would flash it
 * away. After that, motion "system" and followSystem track the OS live.
 *
 * Following the OS merges two sources: the browser's media queries and, in
 * the desktop app, Electron's nativeTheme flags (window.lh, pulled once and
 * pushed on change). The merged answer also goes on <html> as the data-os-*
 * attributes. Those are observations, not settings, so they apply at once
 * and ignore followSystem.
 *
 * It also hands data-motion to Motion (MotionConfig), so every motion/react
 * component follows the setting rather than the OS alone.
 *
 * Mounted in the root layout inside the AppearanceProvider. The settings
 * dialog writes the section and hands the stored delta here.
 */

import { MotionConfig } from "motion/react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useMotionReduced } from "@/components/reduced-motion";
import {
	A11Y_ATTRIBUTES,
	A11Y_STORAGE_KEY,
	A11Y_VAR_NAMES,
	FORCED_COLORS_QUERY,
	MORE_CONTRAST_QUERY,
	OS_ATTRIBUTES,
	REDUCED_MOTION_QUERY,
	REDUCED_TRANSPARENCY_QUERY,
	accessibilityAttributes,
	accessibilityCache,
	accessibilityVars,
	osAccessibility,
	osAttributes,
	resolveAccessibility,
	systemAccessibility,
	type AccessibilitySettings,
	type OsAccessibility,
	type ResolvedAccessibility,
	type SystemAccessibility,
} from "@/src/core";

/** A media query's live match; false on the server. */
function useMediaQuery(query: string): boolean {
	const subscribe = useCallback(
		(listener: () => void) => {
			const mq = window.matchMedia(query);
			mq.addEventListener("change", listener);
			return () => mq.removeEventListener("change", listener);
		},
		[query],
	);
	return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}

/** The desktop app's nativeTheme flags (electron/preload.cjs); null in the browser. */
function useSystemAccessibility(): SystemAccessibility | null {
	const [system, setSystem] = useState<SystemAccessibility | null>(null);
	useEffect(() => {
		const lh = window.lh;
		if (!lh?.getSystemAccessibility || !lh.onSystemAccessibility) return;
		let alive = true;
		let pushed = false;
		// Subscribe before the pull, and let any push win over the pull's
		// snapshot, which may be older.
		const off = lh.onSystemAccessibility((flags) => {
			pushed = true;
			if (alive) setSystem(systemAccessibility(flags));
		});
		lh.getSystemAccessibility()
			.then((flags) => {
				if (alive && !pushed) setSystem(systemAccessibility(flags));
			})
			.catch(() => {
				/* the media queries alone stand */
			});
		return () => {
			alive = false;
			off();
		};
	}, []);
	return system;
}

interface AccessibilityContextValue {
	/** The resolved section; the defaults until the record arrives. */
	accessibility: ResolvedAccessibility;
	/** True once the record has loaded or the settings dialog has written
	 *  the section. Until then the boot script's cached state stands. */
	ready: boolean;
	/** The desktop app's nativeTheme flags; null in the browser. */
	system: SystemAccessibility | null;
	/** What the OS asks for: the media queries merged with `system`. */
	os: OsAccessibility;
	/** Called by the settings dialog after a successful section PUT. */
	onAccessibilityChange: (delta: AccessibilitySettings | undefined) => void;
}

const NO_OS: OsAccessibility = osAccessibility(
	{ reducedMotion: false, moreContrast: false, reducedTransparency: false, forcedColors: false },
	null,
);

const AccessibilityContext = createContext<AccessibilityContextValue>({
	accessibility: resolveAccessibility(undefined),
	ready: false,
	system: null,
	os: NO_OS,
	onAccessibilityChange: () => {},
});

export function useAccessibility() {
	return useContext(AccessibilityContext);
}

export function AccessibilityProvider({ children }: { children: React.ReactNode }) {
	const [delta, setDelta] = useState<AccessibilitySettings | undefined>(undefined);
	const [ready, setReady] = useState(false);
	const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
	const moreContrast = useMediaQuery(MORE_CONTRAST_QUERY);
	const reducedTransparency = useMediaQuery(REDUCED_TRANSPARENCY_QUERY);
	const forcedColors = useMediaQuery(FORCED_COLORS_QUERY);
	const system = useSystemAccessibility();
	const os = useMemo(
		() => osAccessibility({ reducedMotion, moreContrast, reducedTransparency, forcedColors }, system),
		[reducedMotion, moreContrast, reducedTransparency, forcedColors, system],
	);
	// The effective answer on <html>, not the OS query above.
	const motionIsReduced = useMotionReduced();
	const resolved = useMemo(() => resolveAccessibility(delta), [delta]);

	useEffect(() => {
		const root = document.documentElement;
		const attributes = osAttributes(os);
		for (const key of Object.keys(OS_ATTRIBUTES) as (keyof typeof OS_ATTRIBUTES)[]) {
			root.setAttribute(OS_ATTRIBUTES[key], attributes[key]);
		}
	}, [os]);

	// Every reading variable the section doesn't set is removed, so a
	// cleared value hands back to the stylesheet (the boot script may have
	// set it from an older cache).
	useEffect(() => {
		if (!ready) return;
		const root = document.documentElement;
		const attributes = accessibilityAttributes(resolved, os);
		root.setAttribute(A11Y_ATTRIBUTES.focus, attributes.focus);
		root.setAttribute(A11Y_ATTRIBUTES.motion, attributes.motion);
		root.setAttribute(A11Y_ATTRIBUTES.contrast, attributes.contrast);
		root.setAttribute(A11Y_ATTRIBUTES.transparency, attributes.transparency);
		const vars = accessibilityVars(resolved);
		for (const name of A11Y_VAR_NAMES) {
			const value = vars[name];
			if (value !== undefined) root.style.setProperty(name, value);
			else root.style.removeProperty(name);
		}
		try {
			localStorage.setItem(A11Y_STORAGE_KEY, JSON.stringify(accessibilityCache(resolved)));
		} catch {
			/* storage blocked: the next load paints the defaults until the record lands */
		}
	}, [ready, resolved, os]);

	// One fetch per app load. A failed load keeps the boot script's state
	// rather than painting the defaults over a user's settings.
	useEffect(() => {
		let alive = true;
		fetch("/api/settings")
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
			.then((body: { settings?: Record<string, unknown> | null }) => {
				if (!alive) return;
				const section = body.settings?.accessibility;
				setDelta(section && typeof section === "object" ? (section as AccessibilitySettings) : undefined);
				setReady(true);
			})
			.catch(() => {
				/* the cached state stands */
			});
		return () => {
			alive = false;
		};
	}, []);

	// The dialog PUTs the whole section, so its delta is the record's: it
	// applies even when the load's fetch failed.
	const onAccessibilityChange = useCallback((next: AccessibilitySettings | undefined) => {
		setDelta(next);
		setReady(true);
	}, []);

	const value = useMemo(
		() => ({ accessibility: resolved, ready, system, os, onAccessibilityChange }),
		[resolved, ready, system, os, onAccessibilityChange],
	);
	return (
		<AccessibilityContext.Provider value={value}>
			<MotionConfig reducedMotion={motionIsReduced ? "always" : "never"}>{children}</MotionConfig>
		</AccessibilityContext.Provider>
	);
}
