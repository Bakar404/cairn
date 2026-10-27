/**
 * The zero-keys wave's pure seams (owner-locked over Platform's 66dbea9
 * key-presence gate, 2026-09-25): the pill's SSR shape, the SetupDialog's
 * connect screen (the dialog STAYS MOUNTED after a recheck; these pins
 * hold the screen's structure), and the strong-slot connection guard.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { strongKeyless, ZeroKeysPill } from "../components/setup-cta.tsx";
import type { ModelCatalogResponse } from "../src/core/index.ts";
import { SetupConnectBody } from "../components/setup-dialog.tsx";
import { DICTATION_KEYLESS, DEEPGRAM_KEY_ID } from "../components/dictation.tsx";

describe("ZeroKeysPill — the composer-hoisted notice", () => {
	it("the pill takes the CTA's chrome with its own testid and copy", () => {
		const html = renderToStaticMarkup(createElement(ZeroKeysPill, { onOpen: () => {} }));
		assert.ok(html.includes('data-testid="setup-cta-keys"'));
		assert.match(html, />Connect GitHub Copilot<\/button>/);
		assert.doesNotMatch(html, /chats start|—/);
		// the models CTA's testid must not appear on the keys pill
		assert.ok(!html.includes('data-testid="setup-cta"'));
	});
});

describe("SetupConnectBody — stage 1's connect screen", () => {
	it("explains the Copilot dependency and carries the connection row — no key paste", () => {
		const html = renderToStaticMarkup(createElement(SetupConnectBody));
		assert.ok(html.includes('data-testid="setup-stage-keys"'));
		assert.ok(html.includes("Cairn runs every model on your GitHub Copilot subscription. Connect it to pick your models."));
		assert.ok(html.includes('data-testid="copilot-connection"'));
		assert.ok(html.includes('data-testid="copilot-check"'));
		assert.ok(!html.includes('data-testid="setup-key-input"'), "no API-key paste field");
	});
});

describe("the dictation keyless seam (owner dictation trio)", () => {
	it("the client-authored short line — not the route's dev-speak", () => {
		assert.equal(DICTATION_KEYLESS, "Dictation needs a Deepgram key");
	});

	it("the Deepgram row id matches the keys store (KeysSection openRow)", () => {
		assert.equal(DEEPGRAM_KEY_ID, "DEEPGRAM_API_KEY");
	});
});
/** A minimal catalog double — only the two halves the strong-keyless guard
 *  reads: the strong pin and the connected providers list. */
const catalog = (strongProvider: string | null, ...keyedProviders: string[]): ModelCatalogResponse => ({
	models: [],
	defaults: null,
	rolePins: {
		researcher: null,
		demoBuilder: null,
		visualMaker: null,
		extractor: null,
		auditor: null,
	},
	slots: {
		strong: strongProvider
			? { model: { provider: strongProvider, id: `${strongProvider}/model` }, thinkingLevel: "low" }
			: null,
		cheap: null,
		vision: null,
	},
	providers: keyedProviders.map((id) => ({ id, envVar: `${id.toUpperCase()}_API_KEY`, keyPresent: true })),
});

describe("strongKeyless — the pre-send guard's truth (owner interlude, no-orphan-chats)", () => {
	it("strong pinned to a provider that is not connected: the guard FIRES", () => {
		// Copilot is connected, but the strong slot still pins an older build's provider
		assert.equal(strongKeyless(catalog("openrouter", "copilot")), true);
		// nothing connected with a strong pin: also keyless (guard case 1 fires too)
		assert.equal(strongKeyless(catalog("copilot")), true);
	});

	it("strong provider connected: the guard does NOT fire — the normal send path stays open", () => {
		assert.equal(strongKeyless(catalog("copilot", "copilot")), false);
		// belt check: a provider row never counts when keyPresent is false
		const lying = catalog("copilot", "copilot");
		lying.providers[0]!.keyPresent = false;
		assert.equal(strongKeyless(lying), true);
	});

	it("no strong pin (the models guard owns that case) or catalog not loaded: false — the server gate remains the belt", () => {
		assert.equal(strongKeyless(catalog(null, "copilot")), false);
		assert.equal(strongKeyless(undefined), false);
	});
});
