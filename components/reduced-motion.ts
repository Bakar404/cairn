/**
 * Reduced motion (accessibility mode, M27): <html data-motion> is the one
 * answer to "may this move?". The boot script sets it before first paint
 * and the AccessibilityProvider keeps it current (the Motion setting, or
 * the OS while it's "system"). Stylesheets key off it through the
 * motion-safe and motion-reduce variants in globals.css; script that
 * animates — WAAPI, smooth scrolling, the graph canvas — asks here.
 */

import { useSyncExternalStore } from "react";
import { A11Y_ATTRIBUTES } from "@/src/core";

/** True while motion is reduced. False with no document (tests, SSR). */
export function motionReduced(): boolean {
	return typeof document !== "undefined" && document.documentElement.getAttribute(A11Y_ATTRIBUTES.motion) === "reduced";
}

function subscribe(onChange: () => void): () => void {
	const observer = new MutationObserver(onChange);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: [A11Y_ATTRIBUTES.motion] });
	return () => observer.disconnect();
}

/** motionReduced() as live React state. The server snapshot is reduced, so
 *  hydration renders the still version first and only then starts moving. */
export function useMotionReduced(): boolean {
	return useSyncExternalStore(subscribe, motionReduced, () => true);
}
