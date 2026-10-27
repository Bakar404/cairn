/**
 * The keys composition (auth-keys wave, 2026-09-19): env-reflecting store +
 * env-wins precedence + the masked status view. Owner decisions pinned:
 *  - real env always wins; a PUT to an env-owned var persists to the file
 *    but never overwrites the env copy (status reports shadowedByEnv);
 *  - saves/deletes take effect immediately (file + process.env together);
 *  - unknown file vars (an older build's model keys included) are
 *    preserved and surfaced, never editable.
 *
 * LH_AUTH_FILE redirects to a fresh tmp dir BEFORE the imports (the seam is
 * module-load bound); the \"real env\" var is set before src/server/keys.ts
 * first loads so the boot snapshot treats it as real environment. All
 * values here are throwaway test strings — never real secrets.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// THIS PROCESS'S ENV IS THE TEST SUBJECT — strip any inherited catalog vars
// (a developer shell may export REAL keys; tests use throwaway values only,
// never real secrets). The strip affects only this disposable child process.
for (const varName of [
	"OPENROUTER_API_KEY",
	"DEEPGRAM_API_KEY",
	"TAVILY_API_KEY",
	"BRAVE_API_KEY",
	"GOOGLE_SEARCH_API_KEY",
	"GOOGLE_CSE_ID",
	"OPENAI_API_KEY",
	"FUTURE_PLANS_TOKEN",
]) {
	delete process.env[varName];
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-server-keys-"));
const AUTH = path.join(TMP, "auth.json");
process.env.LH_AUTH_FILE = AUTH;

// The file BEFORE first boot: a shadowed Brave key (env will differ), an
// older build's model key, and an unknown var — the last two must survive
// every write and surface as generic read-only rows.
fs.writeFileSync(
	AUTH,
	JSON.stringify({
		BRAVE_API_KEY: "BSA-filefilefile-0123456789",
		OPENROUTER_API_KEY: "sk-or-v1-olderbuildkey",
		FUTURE_PLANS_TOKEN: "opaque-plans-token",
	}),
);
// Real env (set BEFORE the module's first import → boot snapshots it):
process.env.BRAVE_API_KEY = "BSA-envvalue-0123456789-99";

// Import AFTER env setup — module init runs the boot fill-gap + snapshot.
const { deleteKey, initAuthEnv, keyStatuses, keyValue, resolveKeyStatuses, saveKey, isWritableAuthKey } = await import(
	"../src/server/keys.ts"
);
const { authStore } = await import("../src/store/auth.ts");

const ENV_OWNED = "BSA-envvalue-0123456789-99";

after(() => {
	delete process.env.BRAVE_API_KEY;
	delete process.env.OPENROUTER_API_KEY;
	delete process.env.FUTURE_PLANS_TOKEN;
	delete process.env.DEEPGRAM_API_KEY;
	delete process.env.OPENAI_API_KEY;
	fs.rmSync(TMP, { recursive: true, force: true });
});

describe("boot fill-gap + precedence", () => {
	it("env-owned var: env wins, shadow reported, file copy kept", () => {
		const row = keyStatuses().find((s) => s.id === "BRAVE_API_KEY")!;
		assert.equal(row.source, "env");
		assert.ok(row.shadowedByEnv, "file value differs from the env value");
		assert.equal(row.masked, `…${ENV_OWNED.slice(-4)} (${ENV_OWNED.length} chars)`);
		assert.equal(authStore.authVars().BRAVE_API_KEY, "BSA-filefilefile-0123456789", "file copy untouched");
	});

	it("unknown file var: fill-gapped into env, surfaced as a generic row", () => {
		assert.equal(process.env.FUTURE_PLANS_TOKEN, "opaque-plans-token", "reflected at boot");
		const row = keyStatuses().find((s) => s.id === "FUTURE_PLANS_TOKEN")!;
		assert.equal(row.info, null, "no curated form");
		assert.equal(row.source, "file");
		assert.ok(row.present);
	});

	it("an older build's model key: surfaced read-only, never writable", () => {
		const row = keyStatuses().find((s) => s.id === "OPENROUTER_API_KEY")!;
		assert.equal(row.info, null, "no curated form");
		assert.equal(row.source, "file");
		assert.ok(row.present);
		assert.ok(!isWritableAuthKey("OPENROUTER_API_KEY"));
	});

	it("absent curated keys: not present, source none", () => {
		const row = keyStatuses().find((s) => s.id === "DEEPGRAM_API_KEY")!;
		assert.ok(!row.present);
		assert.equal(row.source, "none");
		assert.equal(row.masked, null);
		assert.ok(row.info, "catalog metadata still present for the page form");
	});

	it("keyValue resolves env-first", () => {
		assert.equal(keyValue("BRAVE_API_KEY"), ENV_OWNED);
		assert.equal(keyValue("FUTURE_PLANS_TOKEN"), "opaque-plans-token");
		assert.equal(keyValue("DEEPGRAM_API_KEY"), undefined);
	});
});

describe("saveKey / deleteKey (immediate effect, no restart)", () => {
	it("save reflects into env + file (fill-gap set)", () => {
		const value = "d".repeat(40); // throwaway, ≥ Deepgram floor
		const r = saveKey("DEEPGRAM_API_KEY", value);
		assert.ok(r.ok);
		assert.equal(process.env.DEEPGRAM_API_KEY, value, "env updated immediately");
		assert.equal(authStore.authVars().DEEPGRAM_API_KEY, value, "file updated");
		assert.equal(r.status.source, "file", "the reflected copy is the store's — the file is its origin of truth");
		assert.ok(!r.status.shadowedByEnv);
	});

	it("save to an env-owned var: file updated, env NOT overwritten, shadow reported", () => {
		const r = saveKey("BRAVE_API_KEY", "BSA-newvalue-0123456789-12");
		assert.ok(r.ok);
		assert.equal(process.env.BRAVE_API_KEY, ENV_OWNED, "real env untouched");
		assert.equal(authStore.authVars().BRAVE_API_KEY, "BSA-newvalue-0123456789-12", "file updated for later");
		assert.ok(r.status.shadowedByEnv);
	});

	it("bad shape: rejected, nothing stored or reflected", () => {
		const before = JSON.stringify(authStore.authVars());
		const r = saveKey("DEEPGRAM_API_KEY", "short");
		assert.ok(!r.ok);
		if (!r.ok) assert.match(r.error, /at least 20/);
		assert.equal(JSON.stringify(authStore.authVars()), before);
		assert.equal(process.env.DEEPGRAM_API_KEY, "d".repeat(40));
	});

	it("unknown id: rejected with the supported list", () => {
		const r = saveKey("FUTURE_PLANS_TOKEN", "anything-at-all-here");
		assert.ok(!r.ok);
		if (!r.ok) assert.match(r.error, /FUTURE_PLANS_TOKEN/);
	});

	it("delete removes env + file for fill-gap vars", () => {
		const row = deleteKey("DEEPGRAM_API_KEY");
		assert.ok(!row.present);
		assert.equal(process.env.DEEPGRAM_API_KEY, undefined, "env copy was ours — removed");
		assert.ok(!("DEEPGRAM_API_KEY" in authStore.authVars()));
	});

	it("delete of an env-owned var: file copy gone, env remains (env wins)", () => {
		const row = deleteKey("BRAVE_API_KEY");
		assert.equal(row.source, "env");
		assert.ok(row.present, "still live from the real env");
		assert.ok(!row.shadowedByEnv, "nothing left in the file to shadow");
		assert.equal(process.env.BRAVE_API_KEY, ENV_OWNED);
	});

	it("re-running initAuthEnv is idempotent — deleted vars never resurrect", () => {
		initAuthEnv();
		assert.equal(process.env.DEEPGRAM_API_KEY, undefined, "file entry gone → no re-fill");
	});

	describe("model-provider keys (GitHub Copilot is the only model connection)", () => {
		it("absent provider keys never surface as rows", () => {
			const rows = keyStatuses().map((s) => s.id);
			assert.ok(!rows.includes("OPENAI_API_KEY"), "never saved → no row");
			assert.ok(!rows.includes("ZAI_API_KEY"));
		});

		it("a provider key save is rejected — nothing stored or reflected", () => {
			const r = saveKey("OPENAI_API_KEY", "sk-throwaway-openai-0123456789"); // never a real secret
			assert.ok(!r.ok);
			assert.equal(process.env.OPENAI_API_KEY, undefined);
			assert.ok(!("OPENAI_API_KEY" in authStore.authVars()));
		});

		it("isWritableAuthKey: the curated tool keys only", () => {
			for (const id of ["DEEPGRAM_API_KEY", "TAVILY_API_KEY", "BRAVE_API_KEY"]) assert.ok(isWritableAuthKey(id), id);
			for (const id of ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "FUTURE_PLANS_TOKEN", "ANTHROPIC_AUTH_TOKEN"]) {
				assert.ok(!isWritableAuthKey(id), id);
			}
		});
	});
});

describe("resolveKeyStatuses (pure projection)", () => {
	it("same value in env and file is NOT shadowed (redundant, not misleading)", () => {
		const row = resolveKeyStatuses(
			{ BRAVE_API_KEY: "BSA-same-value-throwaway-01234" },
			{ BRAVE_API_KEY: "BSA-same-value-throwaway-01234" },
			new Set(["BRAVE_API_KEY"]),
		).find((s) => s.id === "BRAVE_API_KEY")!;
		assert.ok(row, "the curated id is always in the projection");
		assert.equal(row.source, "env");
		assert.ok(!row.shadowedByEnv, "same value both places: redundant, not shadowed");
	});
});
