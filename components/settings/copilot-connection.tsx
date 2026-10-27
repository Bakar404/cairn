"use client";

import { useCallback, useEffect, useState } from "react";
import type { CopilotStatus } from "@/src/core";
import { ConnectionRow } from "./connection-controls";
import { notifySettingsSaved } from "@/components/settings-signal";

function isStatus(value: unknown): value is CopilotStatus {
	return !!value && typeof value === "object" && typeof (value as { state?: unknown }).state === "string";
}

function describe(status: CopilotStatus | null): string {
	if (!status || status.state === "unknown") return "Checking…";
	if (status.state === "signed-in") return status.login ? `Signed in as @${status.login}` : "Signed in";
	if (status.state === "signed-out") return "Not signed in";
	return "Unavailable";
}

/** The GitHub Copilot row: every model call runs on the signed-in user's
 *  Copilot subscription. Sign-in happens outside Cairn. */
export function CopilotConnection() {
	const [status, setStatus] = useState<CopilotStatus | null>(null);
	const [busy, setBusy] = useState(false);

	const load = useCallback(async (force: boolean) => {
		setBusy(true);
		try {
			const res = await fetch("/api/copilot", { method: force ? "POST" : "GET", cache: "no-store" });
			const body: unknown = await res.json();
			if (isStatus(body)) {
				setStatus(body);
				if (force) notifySettingsSaved("keys");
			}
		} catch {
			setStatus({ state: "unavailable", message: "Cairn could not reach its server." });
		} finally {
			setBusy(false);
		}
	}, []);

	useEffect(() => {
		void load(false);
	}, [load]);

	const signedIn = status?.state === "signed-in";
	return (
		<div className="flex flex-col gap-1.5 px-1 py-1.5" data-testid="copilot-connection">
			<ConnectionRow label="GitHub Copilot" action="Check again" disabled={busy} onAction={() => void load(true)} actionTestid="copilot-check">
				<span className={`font-ui text-xs ${signedIn ? "text-muted-foreground" : "text-destructive"}`} data-testid="copilot-status">
					{describe(status)}
				</span>
			</ConnectionRow>
			{status && !signedIn && status.state !== "unknown" && (
				<p className="font-ui text-[11px] leading-relaxed text-muted-foreground" data-testid="copilot-help">
					Cairn uses your GitHub Copilot subscription for every model call. Sign in on this machine with{" "}
					<code className="font-mono">gh auth login</code> (or set <code className="font-mono">COPILOT_GITHUB_TOKEN</code> before starting Cairn), then choose Check again.
					{status.state === "unavailable" && status.message ? ` (${status.message})` : ""}
				</p>
			)}
		</div>
	);
}
