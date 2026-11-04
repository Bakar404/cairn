"use client";

/**
 * ENTER SUBMITS — regardless of where focus is (owner round 6, 2026-10-05).
 * The learner often acts on the dock without ever focusing its field, so
 * Enter must submit from ANYWHERE — body focus, a scroll, a stray link.
 * The field's own Enter handler still fires first
 * when it IS focused (this listener sits at the window level, bubble's last
 * stop) — one law, two entry points, no double submit (the focused field's
 * handler claims the event via its own keydown; this hook skips typing
 * surfaces entirely).
 *
 * What the window listener refuses to touch:
 * - typing surfaces (input/textarea/select/contenteditable) — the focused
 *   surface owns its Enter (the dock field, the composer, settings);
 * - modified Enter (⇧↵ is a newline, ⌘/Ctrl↵ belongs to the surface).
 *
 * BUTTONS — the pointer/keyboard split (owner, keyboard round 2026-10-10):
 * a mouse click on a transcript control (a thinking toggle, a copy button)
 * leaves focus ON that button; the learner's next Enter must SUBMIT, not
 * re-activate the toggle — the report that born this rule. Two cases keep
 * native Enter:
 *   1. KEYBOARD-focused controls that Enter activates natively (buttons,
 *      links, <summary>) — :focus-visible means focus arrived by keyboard
 *      (Tab, or an arrow-walked menu), so a link reached with Tab opens
 *      and a toggle reached with Tab toggles (M27);
 *   2. ANYTHING inside an OPEN OVERLAY — menus walk focus with arrows and
 *      Enter activates the walked button natively (menu-shell's contract),
 *      dialogs are their own surfaced layer (the ONE-ESC LAW's layers) and
 *      focus their own container when they open (use-dialog-focus), so
 *      Enter in a dialog never submits the dock behind it.
 * The pointer-clicked transcript button fails both tests → Enter is ours
 * (preventDefault also suppresses the browser's default activation, so
 * the toggle does not fire underneath the submit).
 *
 * The submit callbacks self-guard (empty thinking / canSubmit) — this hook
 * never checks answer validity, only focus honesty.
 */

import { useEffect, useRef } from "react";
import { isTypingSurface } from "@/src/core";

/** Overlay roots that own their keys (hand-rolled menus mark themselves
 *  data-lh-menu; Radix poppers/dialogs carry their own attrs). Shared with
 *  the question dock's key machine. */
export const OVERLAY_ROOTS = '[data-lh-menu], [data-radix-popper-content-wrapper], [role="menu"], [role="dialog"]';

/** Controls whose own Enter activates them natively. */
const ENTER_ACTIVATES = "button, a[href], summary";

/** Pure decision, exported for pins and for chat's Enter-opens-the-check
 *  listener: does the focused element keep native Enter (true), or does
 *  Enter belong to submit (false)? */
export function keepsNativeEnter(el: HTMLElement): boolean {
	// Inside an open overlay: the overlay owns its keys, whatever holds focus.
	if (el.closest(OVERLAY_ROOTS)) return true;
	if (!el.matches(ENTER_ACTIVATES)) return false;
	// Keyboard focus (Tab, or the menu arrows) landed here — Enter activates.
	// (Guarded: a selector engine without the pseudo — linkedom in the
	// test harness — degrades to "not keyboard focus", never throws on
	// every Enter.)
	try {
		return el.matches(":focus-visible");
	} catch {
		return false; // unsupported pseudo — treat as pointer focus
	}
}

/** Mount-scoped: while the dock is mounted (a problem/question is active),
 *  plain Enter anywhere outside a typing surface, an open overlay or a
 *  keyboard-focused control submits it. */
export function useEnterSubmits(submit: () => void): void {
	const submitRef = useRef(submit);
	submitRef.current = submit;
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Enter") return;
			if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
			if (isTypingSurface(e)) return;
			const target = e.target as HTMLElement | null;
			if (target?.closest && keepsNativeEnter(target)) return;
			e.preventDefault();
			submitRef.current();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
}
