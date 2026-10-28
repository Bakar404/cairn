"use client";
/**
 * Settings › Providers › Animations (M13): the Manim renderer. Animations
 * and Manim stills render inside Docker, so this row says what's missing —
 * Docker, its engine, or the one-time image download — and offers the next
 * step. The tutor gets the animation tool only while this reads ready
 * (Settings › Agent can still switch the tool off).
 *
 * API: GET /api/manim[?fresh=1] → ManimStatus; POST /api/manim starts the
 * download, then the row polls until the state settles.
 */
import { useCallback, useEffect, useState } from "react";
import type { ManimStatus } from "@/src/core";
import { Button } from "@/components/ui/button";
import { ConnectionRow } from "./connection-controls";

const POLL_MS = 2000;

function isManimStatus(value: unknown): value is ManimStatus {
	if (!value || typeof value !== "object") return false;
	const v = value as { state?: unknown; reason?: unknown };
	return typeof v.state === "string" && typeof v.reason === "string";
}

/** The short state beside the row label. Pure — exported for tests. */
export function manimStateLabel(status: ManimStatus | null): string {
	switch (status?.state) {
		case undefined:
			return "Checking…";
		case "ready":
			return "Ready";
		case "installing":
			return status.progress ? `Installing · ${status.progress}` : "Installing…";
		case "not-installed":
			return "Not installed";
		case "install-failed":
			return "Install failed";
		case "docker-stopped":
			return "Docker isn't running";
		case "no-docker":
			return "Docker not found";
		default:
			return "Unavailable";
	}
}

export function AnimationRenderer() {
	const [status, setStatus] = useState<ManimStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async (fresh: boolean) => {
		try {
			const res = await fetch(fresh ? "/api/manim?fresh=1" : "/api/manim", { cache: "no-store" });
			const body: unknown = await res.json().catch(() => null);
			if (res.ok && isManimStatus(body)) {
				setStatus(body);
				setError(null);
			} else {
				setError("Cairn couldn't check the renderer.");
			}
		} catch {
			setError("Cairn could not reach its server.");
		}
	}, []);

	useEffect(() => {
		void load(false);
	}, [load]);

	// Poll while the download runs; stop as soon as it settles.
	const installing = status?.state === "installing";
	useEffect(() => {
		if (!installing) return;
		const timer = setInterval(() => void load(false), POLL_MS);
		return () => clearInterval(timer);
	}, [installing, load]);

	const check = async () => {
		setBusy(true);
		await load(true);
		setBusy(false);
	};

	const install = async () => {
		setBusy(true);
		try {
			const res = await fetch("/api/manim", { method: "POST", cache: "no-store" });
			const body: unknown = await res.json().catch(() => null);
			if (res.ok && isManimStatus(body)) {
				setStatus(body);
				setError(null);
			} else {
				setError("Cairn couldn't start the download.");
			}
		} catch {
			setError("Cairn could not reach its server.");
		} finally {
			setBusy(false);
		}
	};

	const canInstall = status?.state === "not-installed" || status?.state === "install-failed";
	return (
		<div className="flex flex-col gap-1.5 px-1 py-1.5" data-testid="animation-renderer" data-state={status?.state ?? "loading"}>
			<ConnectionRow label="Manim renderer" action="Check again" disabled={busy || installing} onAction={() => void check()} actionTestid="manim-check">
				<span
					className={`font-ui text-xs ${status?.state === "install-failed" ? "text-destructive" : "text-muted-foreground"}`}
					data-testid="manim-status"
				>
					{manimStateLabel(status)}
				</span>
			</ConnectionRow>
			{status && (
				<p className="font-ui text-[11px] leading-relaxed text-muted-foreground" data-testid="manim-reason">
					{status.reason}
				</p>
			)}
			{canInstall && (
				<div>
					<Button type="button" size="xs" variant="outline" className="cursor-pointer" disabled={busy} onClick={() => void install()} data-testid="manim-install">
						{status?.state === "install-failed" ? "Try the download again" : "Install renderer"}
					</Button>
				</div>
			)}
			{error && (
				<p role="alert" className="font-ui text-[11px] text-destructive" data-testid="manim-error">
					{error}
				</p>
			)}
		</div>
	);
}
