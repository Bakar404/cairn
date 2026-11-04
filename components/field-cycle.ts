"use client";

import { useEffect } from "react";

/** The index F6 moves focus to (Shift+F6 when `reverse`): the next field
 *  after `current`, wrapping both ways; from outside the chain (`current`
 *  -1) the first field, or the last in reverse. Pure — pinned in
 *  tests/focus-navigation.test.ts. */
export function nextFieldIndex(count: number, current: number, reverse: boolean): number {
	if (current < 0) return reverse ? count - 1 : 0;
	return (current + (reverse ? count - 1 : 1)) % count;
}

/**
 * F6 / SHIFT+F6 WALK THE ACTIVE SURFACE'S TEXT FIELDS (accessibility mode,
 * M27 — the owner's 2026-10-06 plain-Tab cycle, moved off Tab now that Tab
 * moves focus natively). Both directions wrap; from outside the chain F6
 * focuses the FIRST field and Shift+F6 the LAST — "navigate in".
 *
 * The event (not a prop bridge): the global dispatcher (keyboard-shortcuts)
 * sends `lh:kbd-cycle-fields` with `detail.reverse` and each
 * composer-bearing surface answers with its own chain, gathered at event
 * time from live DOM — the fields mount/unmount with the docks, so a query
 * beats stale refs.
 */
export function useFieldCycle(fields: () => readonly HTMLElement[]) {
	useEffect(() => {
		const onCycle = (e: Event) => {
			const reverse = (e as CustomEvent<{ reverse?: boolean } | null>).detail?.reverse === true;
			const list = fields().filter((el) => el.isConnected);
			if (list.length === 0) return;
			const active = document.activeElement;
			const idx = active ? list.findIndex((el) => el === active || el.contains(active)) : -1;
			list[nextFieldIndex(list.length, idx, reverse)]!.focus();
		};
		window.addEventListener("lh:kbd-cycle-fields", onCycle);
		return () => window.removeEventListener("lh:kbd-cycle-fields", onCycle);
	}, [fields]);
}
