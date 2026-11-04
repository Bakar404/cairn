/**
 * Focus navigation (accessibility mode, M27): the two pure steps behind
 * keyboard focus movement.
 *
 * - nextTrapTarget: where Tab / Shift+Tab must send focus so it never
 *   leaves an open dialog (use-dialog-focus). null = the browser's own
 *   move already stays inside.
 * - nextFieldIndex: the text field F6 / Shift+F6 lands on (field-cycle).
 *   Both directions wrap; from outside the chain F6 enters at the first
 *   field and Shift+F6 at the last.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextFieldIndex } from "../components/field-cycle.ts";
import { nextTrapTarget } from "../components/use-dialog-focus.ts";

const stops = ["close", "name", "save"] as const;

describe("nextTrapTarget — Tab stays inside an open dialog", () => {
	it("Tab off the last stop wraps to the first", () => {
		assert.equal(nextTrapTarget(stops, "save", false), "close");
	});

	it("Shift+Tab off the first stop wraps to the last", () => {
		assert.equal(nextTrapTarget(stops, "close", true), "save");
	});

	it("moves between inner stops are the browser's (null)", () => {
		assert.equal(nextTrapTarget(stops, "close", false), null);
		assert.equal(nextTrapTarget(stops, "name", false), null);
		assert.equal(nextTrapTarget(stops, "name", true), null);
		assert.equal(nextTrapTarget(stops, "save", true), null);
	});

	it("from the container or outside, Tab enters at the first stop and Shift+Tab at the last", () => {
		assert.equal(nextTrapTarget(stops, null, false), "close");
		assert.equal(nextTrapTarget(stops, null, true), "save");
		assert.equal(nextTrapTarget<string>(stops, "elsewhere", false), "close");
		assert.equal(nextTrapTarget<string>(stops, "elsewhere", true), "save");
	});

	it("a single stop traps both ways", () => {
		assert.equal(nextTrapTarget(["ok"], "ok", false), "ok");
		assert.equal(nextTrapTarget(["ok"], "ok", true), "ok");
	});

	it("no stops: nothing to send focus to", () => {
		assert.equal(nextTrapTarget([], null, false), null);
		assert.equal(nextTrapTarget([], null, true), null);
	});
});

describe("nextFieldIndex — F6 / Shift+F6 walk the text fields", () => {
	it("F6 steps forward and wraps from the last field to the first", () => {
		assert.equal(nextFieldIndex(3, 0, false), 1);
		assert.equal(nextFieldIndex(3, 1, false), 2);
		assert.equal(nextFieldIndex(3, 2, false), 0);
	});

	it("Shift+F6 steps back and wraps from the first field to the last", () => {
		assert.equal(nextFieldIndex(3, 2, true), 1);
		assert.equal(nextFieldIndex(3, 1, true), 0);
		assert.equal(nextFieldIndex(3, 0, true), 2);
	});

	it("from outside the chain, F6 enters at the first field and Shift+F6 at the last", () => {
		assert.equal(nextFieldIndex(3, -1, false), 0);
		assert.equal(nextFieldIndex(3, -1, true), 2);
	});

	it("a single field stays put both ways", () => {
		assert.equal(nextFieldIndex(1, 0, false), 0);
		assert.equal(nextFieldIndex(1, 0, true), 0);
		assert.equal(nextFieldIndex(1, -1, true), 0);
	});
});
