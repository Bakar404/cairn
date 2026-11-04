"use client";
/**
 * The page's live color scheme (design wave). <html class="dark"> is the
 * single source of truth: the boot script (app/layout.tsx) sets it before
 * first paint and only the AppearanceProvider flips it afterwards. Painters
 * that live outside CSS (graph canvas, Mermaid, demo iframes) subscribe
 * here and redraw on a flip, and on the accessibility mode's contrast and
 * forced colors (M27), which repaint the palette too.
 */

import { useSyncExternalStore } from "react";
import { A11Y_ATTRIBUTES, OS_ATTRIBUTES, type ColorScheme } from "@/src/core";

function read(): ColorScheme {
	return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function subscribe(listener: () => void): () => void {
	// DOM stubs (tests) may lack the observer: the snapshot still reads, it
	// just never changes.
	if (typeof MutationObserver === "undefined") return () => {};
	listeners.add(listener);
	if (!observer) {
		observer = new MutationObserver(() => {
			for (const l of listeners) l();
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class", "style", A11Y_ATTRIBUTES.contrast, OS_ATTRIBUTES.forcedColors],
		});
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) {
			observer?.disconnect();
			observer = null;
		}
	};
}

/** Imperative read for non-React painters; the server render is the
 *  factory (dark). */
export function currentScheme(): ColorScheme {
	return typeof document === "undefined" ? "dark" : read();
}

export function useColorScheme(): ColorScheme {
	return useSyncExternalStore(subscribe, read, () => "dark");
}

/** Changes whenever the painted palette does: the scheme, a custom
 *  background (the AppearanceProvider sets it inline on <html>), high
 *  contrast, or forced colors. Painters that bake colors in (Mermaid svgs)
 *  re-render on it. Each attribute counts only when on, so the provider's
 *  first write of the defaults doesn't change the key. */
function readPaletteKey(): string {
	const root = document.documentElement;
	const contrast = root.getAttribute(A11Y_ATTRIBUTES.contrast) === "high" ? "high" : "";
	const forced = root.getAttribute(OS_ATTRIBUTES.forcedColors) === "active" ? "forced" : "";
	return `${read()}|${root.style.getPropertyValue("--background")}|${contrast}|${forced}`;
}

export function usePaletteKey(): string {
	return useSyncExternalStore(subscribe, readPaletteKey, () => "dark|||");
}

function subscribeSystem(listener: () => void): () => void {
	const mq = window.matchMedia("(prefers-color-scheme: dark)");
	mq.addEventListener("change", listener);
	return () => mq.removeEventListener("change", listener);
}

/** The OS preference, live — what "system" mode follows. */
export function useSystemPrefersDark(): boolean {
	return useSyncExternalStore(
		subscribeSystem,
		() => window.matchMedia("(prefers-color-scheme: dark)").matches,
		() => true,
	);
}
