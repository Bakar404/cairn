"use client";
/**
 * The not-connected surfaces (zero-keys wave, 2026-09-25): when GitHub
 * Copilot is NOT connected, chat / home / /chat/new hoist a composer pill
 * — "Connect GitHub Copilot" — that takes PRECEDENCE over the models
 * setup CTA (the connection comes first in the chain: the model pickers
 * list only what Copilot unlocks). Click opens the SetupDialog, whose
 * stage derives to the connect screen on its own.
 *
 * Truth: the model catalog's providers (GET /api/models) — the Copilot
 * row's keyPresent is its signed-in state. Live updates ride the
 * lh:settings-saved "keys" signal (the Copilot row's "Check again"
 * dispatches it), the same re-read pattern chat.tsx uses for "models".
 */

import { useModelCatalog } from "@/components/model-picker";
import type { ModelCatalogResponse } from "@/src/core";

/** The not-connected truth for the calling page: TRUE only after a
 *  successful catalog read says no provider is connected (pending and
 *  failed reads render nothing — the pill must never flash on a gap, and
 *  a failed read claiming "not connected" would be a lie the CTA flow
 *  then leans on). Re-reads on the keys signal. */
export function useZeroKeys(): boolean {
	const { catalog } = useModelCatalog();
	return catalog ? !catalog.providers.some((provider) => provider.keyPresent) : false;
}

/** The pill itself — the models CTA's chrome and placement, the
 *  connection chain's copy. testid "setup-cta-keys" (the models CTA keeps
 *  "setup-cta"; probes can tell them apart). */
export function ZeroKeysPill({ onOpen, inline = false }: { onOpen: () => void; inline?: boolean }) {
	const button = (
		<button
			type="button"
			data-testid="setup-cta-keys"
			onClick={onOpen}
			className="rounded-sm border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 hover:bg-accent cursor-pointer"
		>
			Connect GitHub Copilot
		</button>
	);
	return inline ? button : <div className="pointer-events-auto mb-2 flex justify-center">{button}</div>;
}
/** Pure: the strong slot is pinned to a provider that is NOT connected
 *  (owner interlude, 2026-09-25 — the original deleted-key scenario, now
 *  a Copilot sign-out or a pin from an older build). The catalog already
 *  knows both halves: slots.strong is the resolved pin, providers[] marks
 *  which provider is connected. False when the strong slot is unset
 *  (the models guard owns that case — this check only runs when slots ARE
 *  configured) or the catalog hasn't loaded (the server gate remains the
 *  belt). Exported for pins. */
export function strongKeyless(catalog: ModelCatalogResponse | undefined): boolean {
	const strong = catalog?.slots.strong;
	if (!strong) return false;
	return !catalog.providers.some((p) => p.id === strong.model.provider && p.keyPresent);
}

/** The strong-slot keyless truth for the PRE-SEND guard (home / /chat/new):
 *  the catalog seam with re-reads on BOTH signals that can flip it — "keys"
 *  (the Copilot connection rechecked) and "models" (the strong slot
 *  re-pinned). Live-updates with the page, never mid-send. */
export function useStrongKeyless(): boolean {
	const { catalog } = useModelCatalog();
	return strongKeyless(catalog);
}
