import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	actionForBinding,
	bindingForAction,
	formatBinding,
	IS_MAC,
	kbdEventForAction,
	KEYBOARD_ACTIONS,
	loadOverrides,
	reservedBindingReason,
} from "../src/core/keyboard.ts";
import { kbdEventForAction as kbdEventForActionFromUi } from "../components/keyboard-shortcuts.tsx";

/**
 * The ⌘B sidebar bug interlude (owner, 2026-09-25): ⌘B did nothing because
 * the sidebar listened on the pre-convention "lh:toggle-sidebar" while the
 * dispatcher sent "lh:kbd-toggle-sidebar". The fix is structural — both
 * sides compose the event name through the ONE helper — and these pins
 * hold the chain together: the registry maps the keypress to the action,
 * the helper spells the event, and the UI dispatcher imports the same
 * helper (not its own copy).
 */

describe("kbdEventForAction — the one spelling for action events", () => {
	it("dispatch and listen names are the helper's output", () => {
		assert.equal(kbdEventForAction("toggle-sidebar"), "lh:kbd-toggle-sidebar");
		assert.equal(kbdEventForAction("sessions-search"), "lh:kbd-sessions-search");
	});

	it("the dispatcher imports the same helper (no second spelling exists)", () => {
		assert.equal(kbdEventForActionFromUi, kbdEventForAction);
	});
});

describe("the ⌘B chain — keypress → binding → action → event", () => {
	it("mod+t is the toggle-user-thinking action (owner round, 2026-10-07)", () => {
		assert.equal(actionForBinding("mod+t"), "toggle-user-thinking");
		assert.equal(bindingForAction("toggle-user-thinking"), "mod+t");
		assert.equal(kbdEventForAction("toggle-user-thinking"), "lh:kbd-toggle-user-thinking");
	});

	it("mod+b is the toggle-sidebar action", () => {
		assert.equal(actionForBinding("mod+b"), "toggle-sidebar");
		assert.equal(bindingForAction("toggle-sidebar"), "mod+b");
		assert.equal(formatBinding("mod+b"), IS_MAC ? "⌘B" : "Ctrl+B");
	});

	it("the event the chain ends in is the one the sidebar answers on", () => {
		const action = actionForBinding("mod+b");
		assert.equal(action, "toggle-sidebar");
		assert.equal(kbdEventForAction(action), "lh:kbd-toggle-sidebar");
	});
});

describe("the thinking cycle — ⌘⇧K via the registry (M27)", () => {
	it("mod+shift+k uses the platform's modifier labels and maps to cycle-thinking", () => {
		assert.equal(actionForBinding("mod+shift+k"), "cycle-thinking");
		assert.equal(bindingForAction("cycle-thinking"), "mod+shift+k");
		assert.equal(formatBinding("mod+shift+k"), IS_MAC ? "⌘⇧K" : "Ctrl+Shift+K");
	});

	it("Tab and Shift+Tab fire no action — they move focus", () => {
		assert.equal(actionForBinding("tab") ?? null, null);
		assert.equal(actionForBinding("shift+tab") ?? null, null);
	});
});

describe("reserved keys (M27) — Tab moves focus, F6 walks the text fields", () => {
	it("Tab, Shift+Tab, F6 and Shift+F6 are refused with a reason", () => {
		assert.equal(reservedBindingReason("tab"), "Tab moves focus, so it can't be a shortcut.");
		assert.equal(reservedBindingReason("shift+tab"), "Tab moves focus, so it can't be a shortcut.");
		assert.equal(reservedBindingReason("f6"), "F6 moves between text fields, so it can't be a shortcut.");
		assert.equal(reservedBindingReason("shift+f6"), "F6 moves between text fields, so it can't be a shortcut.");
	});

	it("an ordinary chord is not reserved", () => {
		assert.equal(reservedBindingReason("mod+k"), undefined);
		assert.equal(reservedBindingReason("mod+tab"), undefined);
	});

	it("a saved override on a reserved key is dropped; the rest load", () => {
		const g = globalThis as { window?: unknown };
		const had = "window" in g;
		const prev = g.window;
		g.window = {
			localStorage: { getItem: () => JSON.stringify({ "toggle-sidebar": "tab", "cycle-thinking": "shift+f6", find: "mod+j" }) },
		};
		try {
			assert.deepEqual(loadOverrides(), { find: "mod+j" });
			assert.equal(actionForBinding("tab") ?? null, null);
			assert.equal(actionForBinding("mod+b"), "toggle-sidebar", "the dropped override falls back to the default");
			assert.equal(actionForBinding("mod+j"), "find");
		} finally {
			if (had) g.window = prev;
			else delete g.window;
		}
	});
});

describe("the Alt session cycle is RETIRED (owner, 2026-10-10)", () => {
	// Barely used, felt laggy — session navigation lives IN the search
	// now (↑/↓ walk the filtered list, Enter opens; sidebar.tsx).
	it("⌥↑ / ⌥↓ / ⌥↵ bind to NOTHING — no stray action fires", () => {
		assert.equal(actionForBinding("alt+arrowup") ?? null, null);
		assert.equal(actionForBinding("alt+arrowdown") ?? null, null);
		assert.equal(actionForBinding("alt+enter") ?? null, null);
	});

	it("the actions are gone from the table (cheat sheet + settings render the registry)", () => {
		const ids = KEYBOARD_ACTIONS.map((a) => a.id as string);
		assert.ok(!ids.includes("cycle-session-prev"));
		assert.ok(!ids.includes("cycle-session-next"));
		assert.ok(!ids.includes("open-session"));
	});
});