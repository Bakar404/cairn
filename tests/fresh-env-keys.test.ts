/**
 * LH_IGNORE_ENV_KEYS=1 — the fresh-user switch (owner, interlude,
 * 2026-09-22): env keys invisible app-wide; only auth.json counts.
 *
 * This file is deliberately its OWN PROCESS under node:test: the switch
 * is BOOT-TIME (initAuthEnv deletes the managed env vars once per
 * process), so the switched boot can only be pinned in a process that
 * starts with the switch set. The UNSET behavior (env wins, fill-gap,
 * shadow semantics) is pinned byte-for-byte by tests/server-keys.test.ts
 * — that file IS the visible case; this file is the hidden one.
 *
 * Model calls never read keys (GitHub Copilot signs in through its own
 * runtime); the managed vars are the curated tool keys (search, speech).
 * The switch works by DELETING them from the process, so assert the
 * deletion directly — that is what a fresh user's tools see.
 *
 * LH_AUTH_FILE redirects to a fresh tmp dir BEFORE the imports (the
 * seam is module-load bound). All values are throwaway test strings —
 * never real secrets.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// THIS PROCESS'S ENV IS THE TEST SUBJECT — strip any inherited catalog
// vars (a developer shell may export REAL keys; tests use throwaway
// values only, never real secrets).
for (const varName of [
	"OPENROUTER_API_KEY",
	"DEEPGRAM_API_KEY",
	"TAVILY_API_KEY",
	"BRAVE_API_KEY",
	"OPENAI_API_KEY",
	"ZAI_API_KEY",
]) {
	delete process.env[varName];
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-fresh-env-keys-"));
const AUTH = path.join(TMP, "auth.json");
process.env.LH_AUTH_FILE = AUTH;

const FILE_BRAVE = "BSA-file-fresh-file-fresh-01";

// The file BEFORE first boot: one file-only key.
fs.writeFileSync(AUTH, JSON.stringify({ BRAVE_API_KEY: FILE_BRAVE }));

// The env the switch must hide — set BEFORE the module's first import:
//  - an env-ONLY tool key (the deletion specimen)
//  - the SAME var the file holds (the collision specimen: under the
//    switch the FILE value must win, and the env copy must be deleted)
process.env.TAVILY_API_KEY = "tvly-env-env-env-0123456789";
process.env.BRAVE_API_KEY = "BSA-env-env-env-0123456789";

// THE SWITCH — set before first import (exactly how the launcher boots).
process.env.LH_IGNORE_ENV_KEYS = "1";

// Import AFTER env setup — module init runs the boot deletion + fill-gap.
const { deleteKey, envKeysIgnored, initAuthEnv, keyStatuses, keyValue, saveKey } = await import(
	"../src/server/keys.ts"
);
const { authStore } = await import("../src/store/auth.ts");

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

describe("the fresh-user switch (boot under LH_IGNORE_ENV_KEYS=1)", () => {
	it("the switch reads live (the launcher exports it before boot)", () => {
		assert.equal(envKeysIgnored(), true);
	});

	it("env-only keys are DELETED from the process — no consumer can find them", () => {
		assert.equal(process.env.TAVILY_API_KEY, undefined, "deleted from process.env at boot");
	});

	it("the env copy of a file-backed var is deleted; the FILE value is what fills the env (only auth.json counts)", () => {
		assert.equal(process.env.BRAVE_API_KEY, FILE_BRAVE, "the env copy died; the fill-gap reflected the file value");
		assert.equal(authStore.authVars().BRAVE_API_KEY, FILE_BRAVE);
	});

	it("keyValue: env keys invisible, file keys visible — and a post-boot env reintroduction stays invisible (belt-and-suspenders)", () => {
		assert.equal(keyValue("TAVILY_API_KEY"), undefined, "env key invisible under the switch");
		assert.equal(keyValue("BRAVE_API_KEY"), FILE_BRAVE, "file key visible");
		// A stray consumer re-sets an env key AFTER boot: the seam still
		// ignores it (the deletion is boot-time; the read guard is live).
		process.env.TAVILY_API_KEY = "tvly-reintroduced-late-0123";
		try {
			assert.equal(keyValue("TAVILY_API_KEY"), undefined, "reintroduced env key stays invisible to the seam");
		} finally {
			delete process.env.TAVILY_API_KEY;
		}
	});

	it("unset switch = today's env-wins behavior (the read seam, live-checked)", () => {
		// The dynamic half of the seam: WITHOUT the switch, keyValue reads
		// env first — today's behavior, byte-for-byte (the boot-snapshot
		// half is pinned in tests/server-keys.test.ts, the visible case).
		process.env.LH_IGNORE_ENV_KEYS = undefined;
		process.env.TAVILY_API_KEY = "tvly-env-wins-0123456789";
		try {
			assert.equal(keyValue("TAVILY_API_KEY"), "tvly-env-wins-0123456789", "env wins without the switch");
			assert.equal(keyValue("BRAVE_API_KEY"), FILE_BRAVE, "the file value fills the env without the switch");
		} finally {
			delete process.env.TAVILY_API_KEY;
			process.env.LH_IGNORE_ENV_KEYS = "1";
		}
	});

	it("the status view is the fresh machine's: file sources only, no env rows, no shadowing", () => {
		const rows = keyStatuses();
		const brave = rows.find((r) => r.id === "BRAVE_API_KEY");
		assert.ok(brave, "the file-backed key has a row");
		assert.equal(brave!.present, true);
		assert.equal(brave!.source, "file", "realEnv is empty under the switch — nothing reports as env");
		assert.equal(brave!.shadowedByEnv, false);
		const tavily = rows.find((r) => r.id === "TAVILY_API_KEY");
		assert.equal(tavily!.present, false, "the env-only key reads as absent");
		assert.equal(tavily!.source, "none");
		assert.equal(rows.some((r) => r.source === "env"), false, "no env-owned key under the switch");
	});

	it("a fresh user CAN add keys mid-session: save reflects file → env (engines see it, no restart)", () => {
		const value = "deepgram-fresh-sim-key-1234567890";
		const result = saveKey("DEEPGRAM_API_KEY", value);
		assert.equal(result.ok, true);
		assert.equal(authStore.authVars().DEEPGRAM_API_KEY, value, "persisted to the file");
		assert.equal(process.env.DEEPGRAM_API_KEY, value, "reflected into env");
		const row = keyStatuses().find((r) => r.id === "DEEPGRAM_API_KEY");
		assert.equal(row!.source, "file", "the status honestly reports the file as the source");
		// and DELETE removes both (fill-gap semantics hold under the switch)
		deleteKey("DEEPGRAM_API_KEY");
		assert.equal(process.env.DEEPGRAM_API_KEY, undefined);
		assert.equal(authStore.authVars().DEEPGRAM_API_KEY, undefined);
	});

	it("re-running initAuthEnv is idempotent — deleted env keys never resurrect", () => {
		process.env.TAVILY_API_KEY = "tvly-zombie-0123456789-zz";
		initAuthEnv();
		assert.equal(process.env.TAVILY_API_KEY, undefined, "a reintroduced env key is re-deleted");
		assert.equal(process.env.BRAVE_API_KEY, FILE_BRAVE, "the file reflection survives re-init");
	});
});
