/**
 * The curated auth-key catalog + shape rules (auth-keys wave, 2026-09-19).
 * PURE, browser-safe — no fs, no env. The catalog drives the auth page's
 * key list (label, description, where-to-get docs link) and the write-side
 * shape validation (owner decision: SHAPE-ONLY validation, no live pings —
 * a revoked key looks fine until a real call fails; that trade was chosen
 * over phoning providers).
 *
 * The store itself is the long-standing flat {VAR: value} auth.json map
 * (see config.AUTH_FILE): keys are identified BY their environment-variable
 * name — the same name a consumer reads from process.env, so the catalog
 * id IS the file key and the env var, one name everywhere.
 *
 * Unknown vars found in the file (outside the catalog) are PRESERVED
 * verbatim and surfaced as generic entries — forward-compat for future
 * entries (e.g. a plans-login token) without a schema change — but they
 * are not hand-writable through the curated API (only the catalog's keys
 * have shapes worth checking and docs worth showing).
 */

/** One curated key entry. `id` is the env-var/file key name. */
export interface AuthKeyInfo {
	id: string;
	/** Human label for the settings page. */
	label: string;
	/** One-sentence what-is-this-for. */
	description: string;
	/** Where the user gets a key (opens in the real browser via the shell). */
	docsUrl: string;
}

/**
 * EMPTY since 2026-10-27: Deepgram dictation and the keyed search engines
 * (Tavily, Brave) retired — web search runs on GitHub Copilot, so no
 * feature needs a key today. Keys saved under the old names stay in the
 * file and surface read-only as unknown vars. A future keyed service is
 * one entry here; the settings page renders whatever the catalog holds.
 */
export const AUTH_KEYS: readonly AuthKeyInfo[] = [];

const AUTH_KEY_IDS: ReadonlySet<string> = new Set(AUTH_KEYS.map((k) => k.id));

export function isKnownAuthKey(id: string): boolean {
	return AUTH_KEY_IDS.has(id);
}

/** Shape-check result: ok, or a 400-ready message naming the expectation. */
export type KeyShapeResult = { ok: true } | { ok: false; error: string };

/**
 * The write-side shape gate (owner decision: reject bad pastes with 400 —
 * a truncated or wrong-family key can never land in the store). Values are
 * TRIMMED first (paste hygiene); empty-after-trim always fails.
 *
 * Only CURATED keys pass. Each gets the generic floor (a length minimum +
 * no whitespace — catches truncated and multi-line pastes); a family that
 * publishes a format (a prefix, a fixed length) adds its rule here.
 * Model access is never a key: every model call runs on the user's
 * GitHub Copilot sign-in.
 */
export function validateKeyShape(id: string, rawValue: string): KeyShapeResult {
	if (!isKnownAuthKey(id)) {
		const supported = [...AUTH_KEY_IDS];
		return {
			ok: false,
			error: supported.length > 0
				? `unknown key "${id}" (supported: ${supported.join(", ")})`
				: `unknown key "${id}" (no keys are configurable)`,
		};
	}
	const value = rawValue.trim();
	return value.length >= 20 && !/\s/.test(value)
		? { ok: true }
		: { ok: false, error: `${id} must be at least 20 characters with no whitespace` };
}

/** A masked key never leaves the server as plaintext (owner decision:
 *  last 4 chars + length — enough to identify which key is stored after
 *  rotating between several, and to spot a mis-pasted family). */
export function maskKey(value: string): string {
	const v = value.trim();
	if (v.length <= 4) return `…${v}`; // degenerate paste — still never the whole value
	return `…${v.slice(-4)}`;
}

/** One key's status row for the GET view (never carries plaintext). */
export interface AuthKeyStatus {
	id: string;
	/** Catalog metadata when the key is curated; null for unknown-file-var
	 *  entries (preserved + surfaced, but no curated form to edit through). */
	info: AuthKeyInfo | null;
	/** A key is present when EITHER the environment or the file has it. */
	present: boolean;
	/** The masked tail + character count, e.g. "…ab12 (64 chars)". */
	masked: string | null;
	/** Where the live value comes from, given env-wins precedence. */
	source: "env" | "file" | "none";
	/** True when the file holds a value that the environment shadows — the
	 *  settings page explains why a saved key is not the live one. */
	shadowedByEnv: boolean;
}
