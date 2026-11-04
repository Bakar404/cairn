"use client";

import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * DIALOG FOCUS (accessibility mode, M27): the one seam every modal surface
 * shares now that Tab moves focus natively.
 *
 * - Opening remembers the opener and moves focus in: an autoFocus that
 *   already landed inside stays, else the initial target, else the first
 *   tab stop, else the container itself. The opener is read during the
 *   opening render — before commit, so before React applies an autoFocus
 *   inside the dialog.
 * - Tab and Shift+Tab wrap inside the topmost open dialog.
 * - Closing puts focus back on the opener when it's still in the document
 *   and focus would otherwise fall to the page body. A close that moved
 *   focus somewhere on purpose keeps it there. A dialog opened from a menu
 *   item returns to the menu's trigger instead (the item is gone by then).
 *
 * The trap listens on the document in the bubble phase, after React's own
 * root listener, so a React handler that claims Tab (preventDefault) wins.
 * Focus in a floating menu or popover (portaled outside the dialog) or in
 * another modal (ConnectionDialog keeps its own trap) is left alone.
 */

/** What can be a tab stop. Exported so the e2e tab walk
 *  (e2e/keyboard.spec.ts) counts stops the way the trap does. */
export const TABBABLE = [
	"a[href]",
	"area[href]",
	"button:not([disabled])",
	"input:not([disabled]):not([type=hidden])",
	"select:not([disabled])",
	"textarea:not([disabled])",
	"iframe",
	"audio[controls]",
	"video[controls]",
	"[contenteditable]:not([contenteditable=false])",
	"summary",
	"[tabindex]",
].join(", ");

/** Floating layers that live outside a dialog's DOM but above it. */
const OVERLAY_ROOTS = '[data-lh-menu], [data-radix-popper-content-wrapper], [role="menu"], [role="listbox"]';

/** The root's tab stops in DOM order: not taken out of the sequence
 *  (tabIndex -1), rendered, visible and not inert. */
export function tabbables(root: Element): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(
		(el) =>
			el.tabIndex >= 0 &&
			!el.closest("[inert]") &&
			el.getClientRects().length > 0 &&
			getComputedStyle(el).visibility !== "hidden",
	);
}

/** Where Tab must send focus to stay inside a dialog, or null when the
 *  browser's own move already stays inside. `current` is the focused tab
 *  stop, or null when focus sits on none of them (the container itself, or
 *  outside the dialog): forward then enters at the first stop, backward
 *  at the last. Pure — pinned in tests/focus-navigation.test.ts. */
export function nextTrapTarget<T>(stops: readonly T[], current: T | null, backwards: boolean): T | null {
	if (stops.length === 0) return null;
	const first = stops[0]!;
	const last = stops[stops.length - 1]!;
	const at = current === null ? -1 : stops.indexOf(current);
	if (at < 0) return backwards ? last : first;
	if (backwards) return at === 0 ? last : null;
	return at === stops.length - 1 ? first : null;
}

export interface DialogFocusOptions {
	/** Where focus lands on open: an element (a destructive dialog's Cancel)
	 *  or "container" (the dialog itself, so a screen reader announces its
	 *  label before any control). Default: the first tab stop. */
	initialFocus?: RefObject<HTMLElement | null> | "container";
}

// Open dialogs, oldest first: only the topmost one traps.
const openDialogs: HTMLElement[] = [];

function focusedElement(): Element | null {
	return typeof document === "undefined" ? null : document.activeElement;
}

/** An element focus can go back to: still in the document and able to
 *  take focus (HTML or SVG). Duck-typed, so the hook needs no DOM global
 *  but `document` (the unit tests render dialogs in linkedom). */
function canRefocus(el: Element | null): el is HTMLElement {
	return !!el && el.isConnected && typeof (el as HTMLElement).focus === "function";
}

/** `ref` is the role="dialog" element (give it tabIndex={-1} so it can
 *  hold focus). A dialog that mounts on open passes `open` = true. */
export function useDialogFocus(
	ref: RefObject<HTMLElement | null>,
	open: boolean,
	{ initialFocus }: DialogFocusOptions = {},
): void {
	// Derived state, so a prop-toggled dialog re-reads the opener on every
	// closed → open change.
	const [opener, setOpener] = useState<Element | null>(() => (open ? focusedElement() : null));
	const [wasOpen, setWasOpen] = useState(open);
	if (open !== wasOpen) {
		setWasOpen(open);
		setOpener(open ? focusedElement() : null);
	}

	useLayoutEffect(() => {
		const container = ref.current;
		if (!open || !container) return;
		openDialogs.push(container);

		// An opener that left the document in this same commit was a menu
		// item whose menu closed as it opened us; the menu has just handed
		// focus back to its trigger (menu-shell), so that's where to return.
		let restoreTo = opener;
		const before = document.activeElement;
		if (!canRefocus(opener) && canRefocus(before) && before !== document.body && !container.contains(before))
			restoreTo = before;

		if (!container.contains(document.activeElement)) {
			const target =
				initialFocus === "container"
					? container
					: (initialFocus?.current ?? tabbables(container)[0] ?? container);
			target.focus({ preventScroll: true });
		}

		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
			if (openDialogs[openDialogs.length - 1] !== container) return;
			const active = document.activeElement;
			const inside = !!active && container.contains(active);
			if (active && !inside && active.closest(OVERLAY_ROOTS)) return;
			const modal = active?.closest('[role="dialog"][aria-modal="true"]');
			if (modal && modal !== container) return;

			const stops = tabbables(container);
			if (stops.length === 0) {
				e.preventDefault();
				container.focus({ preventScroll: true });
				return;
			}
			let current: HTMLElement | null = null;
			if (inside && active && active !== container) {
				current = stops.find((el) => el === active) ?? null;
				if (!current) {
					// Focus on an element outside the tab sequence (tabIndex -1):
					// the browser moves to the next stop in DOM order, which is
					// fine unless no stop lies that way.
					const way = e.shiftKey ? active.DOCUMENT_POSITION_PRECEDING : active.DOCUMENT_POSITION_FOLLOWING;
					if (stops.some((el) => active.compareDocumentPosition(el) & way)) return;
				}
			}
			const target = nextTrapTarget(stops, current, e.shiftKey);
			if (!target) return;
			e.preventDefault();
			target.focus();
		};
		document.addEventListener("keydown", onKeyDown);

		return () => {
			document.removeEventListener("keydown", onKeyDown);
			const at = openDialogs.lastIndexOf(container);
			if (at >= 0) openDialogs.splice(at, 1);
			const now = document.activeElement;
			if (
				canRefocus(restoreTo) &&
				restoreTo !== document.body &&
				!container.contains(restoreTo) &&
				(!now || now === document.body || container.contains(now))
			)
				restoreTo.focus({ preventScroll: true });
		};
	}, [open, ref, initialFocus, opener]);
}
