/**
 * The reply announcer (accessibility mode, M27) under a virtual screen
 * reader. jsdom is the DOM because its MutationObserver reports a live
 * region's text changes as a browser does, and
 * @guidepup/virtual-screen-reader logs what a screen reader would say
 * about them. Timers and the clock are mocked, so each case walks a
 * reply's timeline and pins every phrase spoken, each exactly once.
 */
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { Virtual } from "@guidepup/virtual-screen-reader";
import { AccessibilityProvider } from "../components/settings/accessibility.tsx";
import {
	CLEAR_MS,
	FINISH_GRACE_MS,
	REPLY_FINISHED,
	REPLY_STARTED,
	START_DELAY_MS,
	STEP_DELAY_MS,
	STEP_INTERVAL_MS,
	ReplyAnnouncer,
	type AnnouncedStep,
} from "../components/reply-announcer.tsx";

const STARTED = `polite: ${REPLY_STARTED}`;
const FINISHED = `polite: ${REPLY_FINISHED}`;
const SEARCH = "Searching file contents…";
const READ = "Reading a file…";

interface Announcer {
	/** Re-renders with the chat's busy flag and its running tool step. */
	render(busy: boolean, step?: AnnouncedStep | null): Promise<void>;
	/** Moves the mocked clock. Node's mock clock jumps to the end of a tick
	 *  before it runs the tick's timers, so a call that makes the announcer
	 *  say something ends exactly then: the timers that line sets start from
	 *  the right time. */
	advance(ms: number): Promise<void>;
	/** Everything the virtual screen reader has said since mounting. */
	spoken(): Promise<string[]>;
	region(): HTMLElement;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Mounts the announcer inside the real AccessibilityProvider, whose one
 *  settings fetch answers with `accessibility`, and runs `body` against it. */
async function withAnnouncer(
	t: TestContext,
	accessibility: Record<string, unknown> | undefined,
	body: (announcer: Announcer) => Promise<void>,
): Promise<void> {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
	const { window } = dom;
	Object.defineProperty(window, "matchMedia", {
		value: (media: string) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} }),
	});
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, value] of Object.entries({
		window,
		document: window.document,
		Element: window.Element,
		HTMLElement: window.HTMLElement,
		MutationObserver: window.MutationObserver,
		localStorage: window.localStorage,
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async () => ({ ok: true, json: async () => ({ settings: accessibility ? { accessibility } : {} }) }),
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	}
	const host = window.document.createElement("div");
	window.document.body.append(host);
	const root = createRoot(host);
	const reader = new Virtual();
	let props: { busy: boolean; step: AnnouncedStep | null } = { busy: false, step: null };
	const draw = () =>
		root.render(
			<AccessibilityProvider>
				<ReplyAnnouncer busy={props.busy} step={props.step} />
			</AccessibilityProvider>,
		);
	try {
		await act(async () => draw());
		// The provider's settings fetch lands before anything else happens.
		await act(flush);
		await reader.start({ container: window.document.body, window });
		await reader.clearSpokenPhraseLog();
		const region = () => host.querySelector<HTMLElement>('[data-testid="reply-announcer"]')!;
		assert.equal(region().getAttribute("role"), "status");
		assert.equal(region().textContent, "", "the region is mounted empty");
		await body({
			async render(busy, step = null) {
				props = { busy, step };
				await act(async () => draw());
			},
			async advance(ms) {
				await act(async () => t.mock.timers.tick(ms));
			},
			async spoken() {
				await flush();
				return reader.spokenPhraseLog();
			},
			region,
		});
	} finally {
		try {
			await act(async () => root.unmount());
			await reader.stop();
		} finally {
			window.close();
			for (const [name, descriptor] of previous) {
				if (descriptor) Object.defineProperty(globalThis, name, descriptor);
				else Reflect.deleteProperty(globalThis, name);
			}
		}
	}
}

describe("the reply announcer", () => {
	it("says when a reply starts and when it ends, once each, then clears for the next reply", async (t) => {
		await withAnnouncer(t, undefined, async (a) => {
			await a.render(true);
			await a.advance(START_DELAY_MS - 1);
			assert.deepEqual(await a.spoken(), []);
			await a.advance(1);
			assert.deepEqual(await a.spoken(), [STARTED]);

			await a.advance(2000);
			await a.render(false);
			await a.advance(FINISH_GRACE_MS - 1);
			assert.deepEqual(await a.spoken(), [STARTED]);
			await a.advance(1);
			assert.deepEqual(await a.spoken(), [STARTED, FINISHED]);

			await a.advance(CLEAR_MS);
			assert.equal(a.region().textContent, "");
			await a.render(true);
			await a.advance(START_DELAY_MS);
			await a.render(false);
			await a.advance(FINISH_GRACE_MS);
			assert.deepEqual(await a.spoken(), [STARTED, FINISHED, STARTED, FINISHED]);
		});
	});

	it("says nothing for a flicker, and a short dip between turns stays one reply", async (t) => {
		await withAnnouncer(t, undefined, async (a) => {
			await a.render(true);
			await a.advance(START_DELAY_MS / 2);
			await a.render(false);
			await a.advance(FINISH_GRACE_MS + CLEAR_MS);
			assert.deepEqual(await a.spoken(), []);

			await a.render(true);
			await a.advance(START_DELAY_MS);
			await a.render(false);
			await a.advance(FINISH_GRACE_MS - 1);
			// The owed continuation picks the reply up again.
			await a.render(true);
			await a.advance(2000);
			assert.deepEqual(await a.spoken(), [STARTED]);
			await a.render(false);
			await a.advance(FINISH_GRACE_MS);
			assert.deepEqual(await a.spoken(), [STARTED, FINISHED]);
		});
	});

	it("names a tool step still running after five seconds, once; a quicker step isn't named", async (t) => {
		await withAnnouncer(t, { announceToolSteps: true }, async (a) => {
			await a.render(true);
			await a.advance(START_DELAY_MS);
			await a.render(true, { id: "c1", label: "Listing a directory…" });
			await a.advance(STEP_DELAY_MS - 1);
			await a.render(true, { id: "c2", label: SEARCH });
			await a.advance(STEP_DELAY_MS - 1);
			assert.deepEqual(await a.spoken(), [STARTED]);
			await a.advance(1);
			assert.deepEqual(await a.spoken(), [STARTED, `polite: ${SEARCH}`]);

			// Still running and re-rendered half a minute later: not named again.
			await a.advance(30_000);
			await a.render(true, { id: "c2", label: SEARCH });
			await a.advance(STEP_INTERVAL_MS);
			await a.render(false);
			await a.advance(FINISH_GRACE_MS);
			assert.deepEqual(await a.spoken(), [STARTED, `polite: ${SEARCH}`, FINISHED]);
		});
	});

	it("names steps at least fifteen seconds apart, and the same label on a new call is a new step", async (t) => {
		await withAnnouncer(t, { announceToolSteps: true }, async (a) => {
			await a.render(true);
			await a.advance(START_DELAY_MS);
			await a.render(true, { id: "c1", label: READ });
			await a.advance(STEP_DELAY_MS);
			assert.deepEqual(await a.spoken(), [STARTED, `polite: ${READ}`]);

			await a.advance(1000);
			await a.render(true, { id: "c2", label: READ });
			await a.advance(STEP_INTERVAL_MS - 1000 - 1);
			assert.deepEqual(await a.spoken(), [STARTED, `polite: ${READ}`], "held back until 15 s after c1");
			// c1's line has been cleared by now, so the same words are a new change.
			assert.equal(a.region().textContent, "");
			await a.advance(1);
			await a.render(false);
			await a.advance(FINISH_GRACE_MS);
			assert.deepEqual(await a.spoken(), [STARTED, `polite: ${READ}`, `polite: ${READ}`, FINISHED]);
		});
	});

	it("doesn't name tool steps unless Announce tool steps is on", async (t) => {
		await withAnnouncer(t, undefined, async (a) => {
			await a.render(true);
			await a.advance(START_DELAY_MS);
			await a.render(true, { id: "c1", label: SEARCH });
			await a.advance(60_000);
			await a.render(false);
			await a.advance(FINISH_GRACE_MS);
			assert.deepEqual(await a.spoken(), [STARTED, FINISHED]);
		});
	});
});
