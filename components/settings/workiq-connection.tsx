"use client";
/**
 * Settings › Providers › Work IQ (M10): the one-time setup the learner does
 * in a terminal, and a Test connection button that asks Work IQ one short
 * question. Cairn never accepts the license or signs in for the learner.
 * Whether the tutor may ask Work IQ is a separate switch in Settings ›
 * Agent › Tools (off by default).
 *
 * API: POST /api/workiq → WorkIqTestResult.
 */
import { useState } from "react";
import { WORKIQ_EULA_URL, WORKIQ_SETUP_STEPS, type WorkIqTestResult } from "@/src/core";
import { ConnectionRow } from "./connection-controls";

export type WorkIqTestState =
	| { state: "idle" }
	| { state: "testing" }
	| { state: "ok" }
	| { state: "failed"; error: string };

function isTestResult(value: unknown): value is WorkIqTestResult {
	if (!value || typeof value !== "object") return false;
	const v = value as { ok?: unknown; error?: unknown };
	return v.ok === true || (v.ok === false && typeof v.error === "string");
}

/** The short state beside the row label. Pure — exported for tests. */
export function workIqStateLabel(test: WorkIqTestState): string {
	switch (test.state) {
		case "idle":
			return "Not tested";
		case "testing":
			return "Testing… (can take a minute)";
		case "ok":
			return "Connected";
		case "failed":
			return "Couldn't connect";
	}
}

export function WorkIqConnection() {
	const [test, setTest] = useState<WorkIqTestState>({ state: "idle" });

	const run = async () => {
		setTest({ state: "testing" });
		try {
			const res = await fetch("/api/workiq", { method: "POST", cache: "no-store" });
			const body: unknown = await res.json().catch(() => null);
			if (res.ok && isTestResult(body)) setTest(body.ok ? { state: "ok" } : { state: "failed", error: body.error });
			else setTest({ state: "failed", error: "Cairn couldn't run the test." });
		} catch {
			setTest({ state: "failed", error: "Cairn could not reach its server." });
		}
	};

	return (
		<div className="flex flex-col gap-1.5 px-1 py-1.5" data-testid="workiq-connection" data-state={test.state}>
			<ConnectionRow
				label="Work IQ"
				action="Test connection"
				disabled={test.state === "testing"}
				onAction={() => void run()}
				actionTestid="workiq-test"
			>
				<span
					className={`font-ui text-xs ${test.state === "failed" ? "text-destructive" : "text-muted-foreground"}`}
					data-testid="workiq-status"
				>
					{workIqStateLabel(test)}
				</span>
			</ConnectionRow>
			{test.state === "failed" && (
				<p role="alert" className="font-ui text-[11px] leading-relaxed text-destructive" data-testid="workiq-error">
					{test.error}
				</p>
			)}
			<p className="font-ui text-[11px] leading-relaxed text-muted-foreground">
				Lets the tutor ask Microsoft 365 Copilot which parts of a subject your work already touches, so it knows
				where to start probing. Needs a Microsoft 365 Copilot license. Set it up once in a terminal:
			</p>
			<ol
				className="flex list-decimal flex-col gap-1 pl-5 font-ui text-[11px] leading-relaxed text-muted-foreground"
				data-testid="workiq-setup"
			>
				{WORKIQ_SETUP_STEPS.map((step) => (
					<li key={step.title}>
						<span className="text-foreground">{step.title}</span>
						{step.command && (
							<>
								{" — "}
								<code className="select-all rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
									{step.command}
								</code>
							</>
						)}
						{step.note && <> — {step.note}</>}
					</li>
				))}
			</ol>
			<p className="font-ui text-[11px] leading-relaxed text-muted-foreground">
				Then switch it on in Settings › Agent › Tools. Questions run under your own sign-in and may use Copilot
				Credits.{" "}
				<a
					href={WORKIQ_EULA_URL}
					target="_blank"
					rel="noopener noreferrer"
					className="underline underline-offset-2 hover:text-foreground"
				>
					About Work IQ ↗
				</a>
			</p>
		</div>
	);
}
