/**
 * enter-submits + focus-hygiene — the pointer/keyboard Enter split and the
 * transient-control blur (owner, keyboard round 2026-10-10).
 *
 * The regression this pins: clicking a transcript control (a thinking
 * toggle) left focus on its <button>; the learner's next Enter re-activated
 * the toggle instead of submitting. The law now: Enter from a
 * POINTER-focused transcript button submits (the window listener also
 * preventDefaults, suppressing the default activation underneath);
 * keyboard-focused controls (buttons, links, <summary>) and anything inside
 * an open overlay (menus walk focus with arrows, dialogs are their own
 * layer and focus their own container on open) keep native Enter.
 */
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { describe, it } from "node:test";
import { keepsNativeEnter } from "../components/enter-submits.ts";
import { blurAfterPointerClick } from "../components/focus-hygiene.ts";

const { document } = parseHTML("<html><body></body></html>");

function elementIn(attrs: Record<string, string>, tag = "button"): HTMLElement {
	const host = document.createElement("div");
	for (const [k, v] of Object.entries(attrs)) host.setAttribute(k, v);
	const el = document.createElement(tag);
	if (tag === "button") (el as HTMLButtonElement).type = "button";
	if (tag === "a") el.setAttribute("href", "/chat/x");
	host.appendChild(el);
	document.body.appendChild(host);
	return el;
}

const buttonIn = (attrs: Record<string, string>) => elementIn(attrs);

/** linkedom lacks :focus-visible — stub it on, keep every other selector real. */
function keyboardFocused(el: HTMLElement): HTMLElement {
	const real = el.matches.bind(el);
	(el as unknown as { matches: (sel: string) => boolean }).matches = (sel: string) =>
		sel === ":focus-visible" || real(sel);
	return el;
}

describe("keepsNativeEnter (the pointer/keyboard Enter split)", () => {
	it("a transcript button (pointer-focused) does NOT keep native Enter — Enter submits", () => {
		const b = buttonIn({});
		assert.equal(keepsNativeEnter(b), false);
	});

	it("a keyboard-focused button keeps native Enter (:focus-visible)", () => {
		assert.equal(keepsNativeEnter(keyboardFocused(buttonIn({}))), true);
	});

	it("a link or <summary> reached with Tab keeps native Enter; a pointer-focused link does not", () => {
		assert.equal(keepsNativeEnter(keyboardFocused(elementIn({}, "a"))), true);
		assert.equal(keepsNativeEnter(keyboardFocused(elementIn({}, "summary"))), true);
		assert.equal(keepsNativeEnter(elementIn({}, "a")), false);
	});

	it("a keyboard-focused element Enter does not activate (a plain div) leaves Enter to submit", () => {
		assert.equal(keepsNativeEnter(keyboardFocused(elementIn({}, "div"))), false);
	});

	it("buttons inside overlays keep native Enter: hand-rolled menu, Radix popper, dialog, menu role", () => {
		assert.equal(keepsNativeEnter(buttonIn({ "data-lh-menu": "" })), true);
		assert.equal(
			keepsNativeEnter(buttonIn({ "data-radix-popper-content-wrapper": "" })),
			true,
		);
		assert.equal(keepsNativeEnter(buttonIn({ role: "dialog" })), true);
		assert.equal(keepsNativeEnter(buttonIn({ role: "menu" })), true);
	});

	it("anything focused inside an open dialog keeps Enter — even the dialog's own container", () => {
		assert.equal(keepsNativeEnter(elementIn({ role: "dialog" }, "div")), true);
		const container = document.createElement("div");
		container.setAttribute("role", "dialog");
		document.body.appendChild(container);
		assert.equal(keepsNativeEnter(container), true);
	});

	it("a selector engine without :focus-visible degrades to pointer-focus, never throws", () => {
		const b = buttonIn({});
		assert.doesNotThrow(() => keepsNativeEnter(b));
		assert.equal(keepsNativeEnter(b), false);
	});
});

describe("blurAfterPointerClick (focus hygiene)", () => {
	it("a POINTER click (detail > 0) blurs the transient control", () => {
		const b = buttonIn({});
		let blurred = false;
		b.blur = () => {
			blurred = true;
		};
		blurAfterPointerClick({ detail: 1, currentTarget: b });
		assert.equal(blurred, true);
	});

	it("a KEYBOARD-activated click (detail 0) keeps focus", () => {
		const b = buttonIn({});
		let blurred = false;
		b.blur = () => {
			blurred = true;
		};
		blurAfterPointerClick({ detail: 0, currentTarget: b });
		assert.equal(blurred, false);
	});
});
