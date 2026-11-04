/**
 * Input modality (accessibility mode, M27): <html data-input-modality> says
 * whether the last input was the keyboard or a pointer. Tab or F6 marks it
 * "keyboard", any pointer press marks it "pointer". The focus outline
 * (globals.css) draws only in keyboard modality, and script asks
 * keyboardModality() for the same answer — a tooltip opens on keyboard
 * focus, and a quiz row Tab lands on becomes the walked row.
 */

/** Start tracking; returns the cleanup. Capture phase on window, so the
 *  mark lands before focus moves and before any handler can stop the event;
 *  it never claims a key. Mounted once, by KeyboardShortcuts. */
export function trackInputModality(): () => void {
	const root = document.documentElement;
	const onKey = (e: KeyboardEvent) => {
		if (e.key === "Tab" || e.key === "F6") root.dataset.inputModality = "keyboard";
	};
	const onPointer = () => {
		root.dataset.inputModality = "pointer";
	};
	window.addEventListener("keydown", onKey, true);
	window.addEventListener("pointerdown", onPointer, true);
	return () => {
		window.removeEventListener("keydown", onKey, true);
		window.removeEventListener("pointerdown", onPointer, true);
	};
}

/** True while the last input was Tab or F6. */
export function keyboardModality(): boolean {
	return typeof document !== "undefined" && document.documentElement.dataset.inputModality === "keyboard";
}
