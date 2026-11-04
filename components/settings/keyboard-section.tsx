"use client";
/**
 * The Keyboard section (thin settings wave): view / rebind / reset over
 * core/keyboard.ts's registry. The overrides persist in localStorage
 * (lh:keymap, overrides-only, merged over DEFAULT_BINDINGS), so rebinding
 * is INSTANT — the dispatcher reads the map per keydown, no reload.
 *
 * Rebind flow: click Rebind → the row listens for the next keydown
 * (capture phase, preventDefault — nothing types anywhere), eventBinding
 * normalizes it, saveOverrides persists. Escape cancels. displayOnly
 * actions (a surface owns those keys — the question dock's row machine)
 * are listed for reading but never rebindable.
 *
 * Reserved keys (M27): Tab and Shift+Tab move focus and F6 / Shift+F6
 * walk the text fields, so a rebind refuses them — the row stays armed
 * and its status line says why and how to leave (Esc). The line is an
 * always-mounted role="status" while the row is armed, so a screen
 * reader announces the refusal.
 *
 * Thin: no conflict detection — if a new binding collides with another
 * action's, the first match in registry order wins; the cheat sheet shows
 * both. Detection belongs to the designed wave.
 */

import { useEffect, useRef, useState } from "react";
import {
	KEYBOARD_ACTIONS,
	eventBinding,
	formatBinding,
	loadOverrides,
	reservedBindingReason,
	saveOverrides,
	type KeyAction,
	type KeyScope,
} from "@/src/core";
import { SettingsRow } from "./controls.tsx";

const SCOPES: { scope: KeyScope; label: string }[] = [
	{ scope: "global", label: "Global" },
	{ scope: "chat", label: "Chat" },
	{ scope: "graph", label: "Graph" },
];

/** The overrides map after ONE change (pure — exported for tests):
 *  binding null = reset the action to its default (key removed). */
export function nextOverrides(
	current: Partial<Record<KeyAction, string>>,
	id: KeyAction,
	binding: string | null,
): Partial<Record<KeyAction, string>> {
	const next = { ...current };
	if (binding === null) delete next[id];
	else next[id] = binding;
	return next;
}

export function KeyboardSection() {
	const [overrides, setOverrides] = useState<Partial<Record<KeyAction, string>>>({});
	const [rebinding, setRebinding] = useState<KeyAction | null>(null);
	const [refused, setRefused] = useState<string | null>(null);
	const [nonce, setNonce] = useState(0);
	const rebindButtons = useRef(new Map<KeyAction, HTMLButtonElement>());
	const lastArmed = useRef<KeyAction | null>(null);

	// localStorage is read post-mount (SSR-safe); `nonce` re-reads after writes.
	useEffect(() => {
		setOverrides(loadOverrides());
	}, [nonce]);

	// Arming swaps the row's Rebind button for Cancel, so focus drops to the
	// page. When the rebind ends, focus goes back to that row's Rebind
	// button unless it has already landed somewhere else.
	useEffect(() => {
		const was = lastArmed.current;
		lastArmed.current = rebinding;
		if (rebinding || !was) return;
		const active = document.activeElement;
		if (active && active !== document.body) return;
		rebindButtons.current.get(was)?.focus({ preventScroll: true });
	}, [rebinding]);

	// The capture listener — only while a rebind is armed.
	useEffect(() => {
		setRefused(null);
		if (!rebinding) return;
		const onKey = (e: KeyboardEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (e.key === "Escape") {
				setRebinding(null);
				return;
			}
			// Modifier keydowns arrive one by one (⌘ down, then ⇧, then the
			// key) — each is a keydown this capture listener sees. They are
			// not bindings; keep listening for the real key.
			if (e.key === "Control" || e.key === "Meta" || e.key === "Alt" || e.key === "Shift") return;
			const binding = eventBinding(e);
			if (!binding) return;
			const reason = reservedBindingReason(binding);
			if (reason) {
				setRefused(reason);
				return;
			}
			const next = nextOverrides(loadOverrides(), rebinding, binding);
			saveOverrides(next);
			setRebinding(null);
			setNonce((n) => n + 1);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [rebinding]);

	function resetOne(id: KeyAction) {
		saveOverrides(nextOverrides(loadOverrides(), id, null));
		setNonce((n) => n + 1);
	}

	function resetAll() {
		saveOverrides({});
		setNonce((n) => n + 1);
	}

	const overridden = (id: KeyAction) => overrides[id] !== undefined;

	return (
		<>
			{SCOPES.map(({ scope, label }) => {
				const actions = KEYBOARD_ACTIONS.filter((a) => a.scope === scope);
				if (!actions.length) return null;
				return (
					<div key={scope} data-testid={`kbd-scope-${scope}`}>
						<p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground/70">{label}</p>
						<div className="flex flex-col gap-2">
							{actions.map((def) => {
								const effective = overrides[def.id] ?? def.binding;
								const armed = rebinding === def.id;
								return (
									<SettingsRow
										key={def.id}
										label={def.label}
										hint={
											// Full muted ink, not the row's /70: text-xs must pass AA
											// contrast (M27; the axe baseline only goes down).
											def.displayOnly ? (
												<span className="text-muted-foreground">Fixed — part of this screen</span>
											) : armed ? (
												<span role="status" data-testid={`kbd-refused-${def.id}`} className="text-muted-foreground">
													{refused ? `${refused} Press another key, or Esc to cancel.` : ""}
												</span>
											) : undefined
										}
										testid={`kbd-row-${def.id}`}
									>
										<span className="flex items-center gap-2">
											<kbd className="rounded-sm border border-border bg-muted px-1.5 py-0.5 font-ui text-xs">
												{armed ? "Press keys…" : formatBinding(effective)}
											</kbd>
											{def.displayOnly ? null : armed ? (
												<button
													type="button"
													onClick={() => setRebinding(null)}
													className="text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
												>
													Cancel
												</button>
											) : (
												<>
													<button
														type="button"
														ref={(el) => {
															if (el) rebindButtons.current.set(def.id, el);
															else rebindButtons.current.delete(def.id);
														}}
														onClick={() => setRebinding(def.id)}
														data-testid={`kbd-rebind-${def.id}`}
														className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
													>
														Rebind
													</button>
													{overridden(def.id) && (
														<button
															type="button"
															onClick={() => resetOne(def.id)}
															data-testid={`kbd-reset-${def.id}`}
															className="text-xs text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
														>
															Reset
														</button>
													)}
												</>
											)}
										</span>
									</SettingsRow>
								);
							})}
						</div>
					</div>
				);
			})}
			<div className="mt-1 flex items-center justify-between">
				<span className="text-xs text-muted-foreground/70">Stored on this device (lh:keymap) — overrides only.</span>
				<button
					type="button"
					onClick={resetAll}
					data-testid="kbd-reset-all"
					className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
				>
					Reset all to defaults
				</button>
			</div>
		</>
	);
}