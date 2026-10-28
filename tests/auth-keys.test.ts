/**
 * The curated auth-key catalog + shape rules (auth-keys wave, 2026-09-19)
 * — PURE module, so this file owns no fs. Owner decisions being pinned:
 *  - the catalog is EMPTY since 2026-10-27 (Deepgram dictation and the
 *    keyed search engines retired; web search runs on GitHub Copilot);
 *  - validation is SHAPE-ONLY (no live pings) and bad pastes are 400s;
 *  - masking is last-4 + length — plaintext never leaves the store.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AUTH_KEYS, isKnownAuthKey, maskKey, validateKeyShape } from "../src/core/auth-keys.ts";

describe("the catalog", () => {
	it("is empty — the retired service keys and every provider key are unknown", () => {
		assert.deepEqual(AUTH_KEYS, []);
		for (const id of ["DEEPGRAM_API_KEY", "TAVILY_API_KEY", "BRAVE_API_KEY", "GOOGLE_SEARCH_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY", ""]) {
			assert.ok(!isKnownAuthKey(id), id);
		}
	});
});

describe("validateKeyShape (the 400 gate)", () => {
	it("a retired id is an unknown key, and the message reads well with nothing configurable", () => {
		const r = validateKeyShape("TAVILY_API_KEY", "tvly-abc123def456ghi78");
		assert.ok(!r.ok);
		if (!r.ok) assert.equal(r.error, 'unknown key "TAVILY_API_KEY" (no keys are configurable)');
	});
});

describe("maskKey (plaintext never leaves)", () => {
	it("shows the last 4 only", () => {
		assert.equal(maskKey("sk-or-v1-abcdefgh1234"), "…1234");
	});

	it("never reveals a degenerate short value in full", () => {
		assert.equal(maskKey("ab"), "…ab");
		assert.equal(maskKey("abcd"), "…abcd");
		assert.equal(maskKey("abcde"), "…bcde");
	});

	it("trims before masking", () => {
		assert.equal(maskKey("  sk-or-v1-xyzw9  "), "…yzw9");
	});
});
