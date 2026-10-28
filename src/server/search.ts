/**
 * Web search's server composition: GitHub Copilot's hosted web search
 * behind the core port (core/search.ts). Since 2026-10-27 it is the one
 * engine — the keyed Tavily/Brave adapters and the engine preference
 * retired. It needs no key; it runs on the researcher's model, so it is
 * live only while Copilot is signed in AND the researcher resolves to a
 * Copilot model. Otherwise search is honestly unavailable (the tool says
 * so) — nothing falls back.
 *
 * The agent-layer tool depends on the PORT only (the adapter arrives as
 * an injected dependency), so tests never touch the network.
 */

import { COPILOT_PROVIDER, copilotSearchProvider, copilotSignedIn } from "../agent/copilot/index.ts";
import type { SearchProvider } from "../core/search.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { stores } from "./stores.ts";

/** The Copilot model web search runs on (the researcher's), or
 *  undefined when Copilot search cannot run (signed out, or no model). */
function copilotSearchModel(): string | undefined {
	if (!copilotSignedIn()) return undefined;
	const spec = resolveRoleSpec("researcher", stores.settingsStore.readSettings());
	return spec?.provider === COPILOT_PROVIDER ? spec.id : undefined;
}

/** Search available at all? (the researcher's enable/disable signal).
 *  Read fresh each call, so a sign-in or model change mid-session lands
 *  on the next check (no restart). */
export function searchAvailable(): boolean {
	return copilotSearchModel() !== undefined;
}

/** The LIVE adapter, or null when unavailable. Composed fresh each call —
 *  the tool layer calls this once per search. */
export function searchProvider(): SearchProvider | null {
	const model = copilotSearchModel();
	return model ? copilotSearchProvider({ model }) : null;
}