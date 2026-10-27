"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CopilotAccount, CopilotAccounts, CopilotLogin, CopilotLoginProvider, CopilotStatus } from "@/src/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConnectionRow } from "./connection-controls";
import { notifySettingsSaved } from "@/components/settings-signal";

const POLL_MS = 1500;

const PLAN_LABELS: Record<string, string> = {
	free: "Copilot Free",
	individual: "Copilot Pro",
	individual_pro: "Copilot Pro+",
	business: "Copilot Business",
	enterprise: "Copilot Enterprise",
};

function isStatus(value: unknown): value is CopilotStatus {
	return !!value && typeof value === "object" && typeof (value as { state?: unknown }).state === "string";
}

function isLogin(value: unknown): value is CopilotLogin {
	return !!value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string" && isStatus((value as { step?: unknown }).step);
}

function isAccounts(value: unknown): value is CopilotAccounts {
	return !!value && typeof value === "object" && Array.isArray((value as { accounts?: unknown }).accounts);
}

async function json(res: Response): Promise<unknown> {
	return res.json().catch(() => null);
}

function errorOf(body: unknown, fallback: string): string {
	const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
	return typeof error === "string" && error ? error : fallback;
}

function describe(status: CopilotStatus | null): string {
	if (!status || status.state === "unknown") return "Checking…";
	if (status.state === "signed-in") return status.login ? `Signed in as @${status.login}` : "Signed in";
	if (status.state === "signed-out") return "Not signed in";
	return "Unavailable";
}

function planLabel(plan: string): string {
	return PLAN_LABELS[plan] ?? `Copilot ${plan.replace(/[_-]+/g, " ")}`;
}

function hostLabel(host: string): string {
	return host.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function sourceLabel(source: string): string {
	return source === "gh" ? "from the GitHub CLI" : `from ${source}`;
}

/** Opens GitHub in the browser (the desktop app hands it to the system
 *  browser). The waiting panel keeps a link in case a popup was blocked. */
function openSignInPage(login: CopilotLogin): void {
	if (login.step.state === "browser" && login.step.url) window.open(login.step.url, "_blank", "noopener,noreferrer");
}

/** The GitHub Copilot row: every model call runs on the signed-in user's
 *  Copilot subscription. Sign-in is the Copilot runtime's own browser
 *  sign-in — personal and Enterprise Managed accounts on github.com, or a
 *  GitHub Enterprise Cloud (*.ghe.com) address — and the GitHub CLI's
 *  sign-in counts too. */
export function CopilotConnection() {
	const [status, setStatus] = useState<CopilotStatus | null>(null);
	const [accounts, setAccounts] = useState<CopilotAccounts | null>(null);
	const [login, setLogin] = useState<CopilotLogin | null>(null);
	const hostInput = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [confirming, setConfirming] = useState<string | null>(null);

	const load = useCallback(async (force: boolean) => {
		setBusy(true);
		try {
			const res = await fetch("/api/copilot", { method: force ? "POST" : "GET", cache: "no-store" });
			const body = await json(res);
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

	const loadAccounts = useCallback(async () => {
		try {
			const res = await fetch("/api/copilot/accounts", { cache: "no-store" });
			const body = await json(res);
			setAccounts(res.ok && isAccounts(body) ? body : null);
		} catch {
			setAccounts(null);
		}
	}, []);

	/** A sign-in moved on: finished ones refresh everything that depends on
	 *  the account. */
	const settle = useCallback(
		(next: CopilotLogin | null) => {
			if (next?.step.state === "signed-in") {
				setLogin(null);
				void load(false).then(() => notifySettingsSaved("keys"));
				return;
			}
			setLogin(next?.step.state === "cancelled" ? null : next);
		},
		[load],
	);

	useEffect(() => {
		void load(false);
		// Pick up a sign-in still waiting from before (settings reopened).
		void fetch("/api/copilot/login", { cache: "no-store" })
			.then(json)
			.then((body) => {
				if (isLogin(body)) setLogin(body);
			})
			.catch(() => undefined);
	}, [load]);

	// Signed out too: after signing the active account out, the others
	// stay pickable.
	useEffect(() => {
		if (status?.state === "signed-in" || status?.state === "signed-out") void loadAccounts();
		else setAccounts(null);
	}, [status, loadAccounts]);

	const waitingId = login?.step.state === "browser" ? login.id : null;
	useEffect(() => {
		if (!waitingId) return;
		let stopped = false;
		const timer = setInterval(() => {
			void fetch(`/api/copilot/login?id=${encodeURIComponent(waitingId)}`, { cache: "no-store" })
				.then(async (res) => {
					if (stopped) return;
					if (res.status === 404) {
						setLogin(null);
						setError("This sign-in is no longer active. Start again.");
						return;
					}
					const body = await json(res);
					if (!stopped && isLogin(body) && body.step.state !== "browser") settle(body);
				})
				.catch(() => undefined);
		}, POLL_MS);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [waitingId, settle]);

	async function send(method: "POST" | "PATCH", body: Record<string, unknown>): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/copilot/login", {
				method,
				cache: "no-store",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const answer = await json(res);
			if (!res.ok || !isLogin(answer)) {
				setError(errorOf(answer, "GitHub sign-in is not available right now."));
				return;
			}
			if (answer.step.state === "browser") openSignInPage(answer);
			settle(answer);
		} catch {
			setError("Cairn could not reach its server.");
		} finally {
			setBusy(false);
		}
	}

	const start = (provider: CopilotLoginProvider) => void send("POST", { provider });
	const answer = (input: Record<string, unknown>) => login && void send("PATCH", { id: login.id, ...input });
	/** Closes the panel whatever the server says: a sign-in it no longer
	 *  knows is as good as cancelled. */
	const cancel = () => {
		if (!login) return;
		setLogin(null);
		setError(null);
		void fetch(`/api/copilot/login?id=${encodeURIComponent(login.id)}`, { method: "DELETE", cache: "no-store" }).catch(() => undefined);
	};

	async function changeAccount(action: "switch" | "sign-out", account: CopilotAccount): Promise<void> {
		setBusy(true);
		setError(null);
		setConfirming(null);
		try {
			const res = await fetch("/api/copilot/accounts", {
				method: "POST",
				cache: "no-store",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action, id: account.id }),
			});
			const body = await json(res);
			if (!res.ok || !isAccounts(body)) {
				setError(errorOf(body, "GitHub Copilot could not change accounts."));
				return;
			}
			setAccounts(body);
			await load(false);
			notifySettingsSaved("keys");
		} catch {
			setError("Cairn could not reach its server.");
		} finally {
			setBusy(false);
		}
	}

	const signedIn = status?.state === "signed-in";
	const canSignIn = !!status && status.state !== "unknown" && status.state !== "unavailable";
	const step = login?.step;
	return (
		<div className="flex flex-col gap-1.5 px-1 py-1.5" data-testid="copilot-connection">
			<ConnectionRow label="GitHub Copilot" action="Check again" disabled={busy} onAction={() => void load(true)} actionTestid="copilot-check">
				<span className={`font-ui text-xs ${signedIn ? "text-muted-foreground" : "text-destructive"}`} data-testid="copilot-status">
					{describe(status)}
				</span>
				{signedIn && accounts?.plan && (
					<span className="font-ui text-xs text-muted-foreground" data-testid="copilot-plan">
						· {planLabel(accounts.plan)}
					</span>
				)}
			</ConnectionRow>

			{accounts && accounts.accounts.length > 0 && (
				<ul className="flex flex-col gap-1" data-testid="copilot-accounts">
					{accounts.accounts.map((account) => (
						<li key={account.id} className="flex flex-wrap items-center gap-2 font-ui text-[11px] text-muted-foreground" data-testid="copilot-account">
							<span className="text-foreground">@{account.login}</span>
							<span>{hostLabel(account.host)}</span>
							{account.source && <span>{sourceLabel(account.source)}</span>}
							{account.active ? (
								<span className="rounded-sm border border-border px-1" data-testid="copilot-account-active">In use</span>
							) : (
								<Button type="button" size="xs" variant="ghost" className="h-5 cursor-pointer px-1.5 text-[11px]" disabled={busy} onClick={() => void changeAccount("switch", account)} data-testid="copilot-account-use">
									Use
								</Button>
							)}
							{!account.source && confirming !== account.id && (
								<Button type="button" size="xs" variant="ghost" className="h-5 cursor-pointer px-1.5 text-[11px] text-muted-foreground" disabled={busy} onClick={() => setConfirming(account.id)} data-testid="copilot-account-sign-out">
									Sign out
								</Button>
							)}
							{confirming === account.id && (
								<span className="flex flex-wrap items-center gap-1" data-testid="copilot-account-confirm">
									<span>The GitHub Copilot CLI on this computer shares this sign-in, so it may ask you to sign in again.</span>
									<Button type="button" size="xs" variant="outline" className="h-5 cursor-pointer px-1.5 text-[11px]" disabled={busy} onClick={() => void changeAccount("sign-out", account)} data-testid="copilot-account-sign-out-confirm">
										Sign out
									</Button>
									<Button type="button" size="xs" variant="ghost" className="h-5 cursor-pointer px-1.5 text-[11px]" onClick={() => setConfirming(null)}>
										Keep
									</Button>
								</span>
							)}
						</li>
					))}
				</ul>
			)}

			{step ? (
				<div className="flex flex-col gap-1.5 rounded-md border border-border p-2 font-ui text-[11px] leading-relaxed text-muted-foreground" data-testid="copilot-login" data-state={step.state}>
					{step.state === "browser" && (
						<>
							<p>
								Finish in your browser. GitHub's pages name the GitHub Copilot CLI, whose sign-in Cairn uses. When GitHub says to return to your terminal, come back here; Cairn finishes on its own.
							</p>
							<div className="flex flex-wrap items-center gap-2">
								{step.url && (
									<a href={step.url} target="_blank" rel="noopener noreferrer" className="text-foreground underline underline-offset-2" data-testid="copilot-login-open">
										Open the GitHub sign-in page
									</a>
								)}
								<Button type="button" size="xs" variant="ghost" className="cursor-pointer" disabled={busy} onClick={cancel} data-testid="copilot-login-cancel">
									Cancel
								</Button>
							</div>
						</>
					)}
					{step.state === "needs-host" && (
						<form
							className="flex flex-wrap items-center gap-2"
							onSubmit={(event) => {
								event.preventDefault();
								const host = hostInput.current?.value.trim();
								if (host) answer({ host });
							}}
						>
							<label htmlFor="copilot-login-host" className="w-full">Your GitHub Enterprise Cloud address</label>
							<Input ref={hostInput} id="copilot-login-host" required placeholder="your-company.ghe.com" autoComplete="off" spellCheck={false} className="h-7 max-w-64 text-xs" data-testid="copilot-login-host" />
							<Button type="submit" size="xs" variant="outline" className="cursor-pointer" disabled={busy} data-testid="copilot-login-continue">
								Continue
							</Button>
							<Button type="button" size="xs" variant="ghost" className="cursor-pointer" disabled={busy} onClick={cancel} data-testid="copilot-login-cancel">
								Cancel
							</Button>
						</form>
					)}
					{step.state === "choose-account" && (
						<>
							<p>Choose the account Cairn should use:</p>
							<div className="flex flex-wrap items-center gap-2">
								{step.accounts.map((choice) => (
									<Button key={choice.id} type="button" size="xs" variant="outline" className="cursor-pointer" disabled={busy} onClick={() => answer({ account: choice.id })} data-testid="copilot-login-choice">
										@{choice.login} · {hostLabel(choice.host)}
									</Button>
								))}
								<Button type="button" size="xs" variant="ghost" className="cursor-pointer" disabled={busy} onClick={cancel} data-testid="copilot-login-cancel">
									Cancel
								</Button>
							</div>
						</>
					)}
					{step.state === "needs-consent" && (
						<>
							<p>This computer has no system keychain for the sign-in. Save it in a plain-text file on this computer instead?</p>
							<div className="flex flex-wrap items-center gap-2">
								<Button type="button" size="xs" variant="outline" className="cursor-pointer" disabled={busy} onClick={() => answer({ consent: true })} data-testid="copilot-login-consent">
									Save sign-in
								</Button>
								<Button type="button" size="xs" variant="ghost" className="cursor-pointer" disabled={busy} onClick={cancel} data-testid="copilot-login-cancel">
									Cancel
								</Button>
							</div>
						</>
					)}
					{step.state === "failed" && (
						<>
							<p className="text-destructive" data-testid="copilot-login-error">{step.message}</p>
							<div className="flex flex-wrap items-center gap-2">
								<Button type="button" size="xs" variant="outline" className="cursor-pointer" disabled={busy} onClick={() => start(login.provider)} data-testid="copilot-login-retry">
									Try again
								</Button>
								<Button type="button" size="xs" variant="ghost" className="cursor-pointer" onClick={() => setLogin(null)}>
									Dismiss
								</Button>
							</div>
						</>
					)}
				</div>
			) : (
				canSignIn && (
					<div className="flex flex-wrap items-center gap-2">
						{signedIn && <span className="font-ui text-[11px] text-muted-foreground">Add an account:</span>}
						<Button type="button" size="xs" variant={signedIn ? "ghost" : "outline"} className="cursor-pointer" disabled={busy} onClick={() => start("github")} data-testid="copilot-sign-in">
							{signedIn ? "GitHub" : "Sign in with GitHub"}
						</Button>
						<Button type="button" size="xs" variant="ghost" className="cursor-pointer text-muted-foreground hover:text-foreground" disabled={busy} onClick={() => start("ghe")} data-testid="copilot-sign-in-ghe">
							GitHub Enterprise Cloud (ghe.com)
						</Button>
					</div>
				)
			)}

			{error && (
				<p className="font-ui text-[11px] text-destructive" data-testid="copilot-error">
					{error}
				</p>
			)}

			{status && !signedIn && !login && status.state !== "unknown" && (
				<p className="font-ui text-[11px] leading-relaxed text-muted-foreground" data-testid="copilot-help">
					Cairn uses your GitHub Copilot subscription for every model call. Sign in with your GitHub account — personal or Enterprise Managed (EMU); accounts on a ghe.com address use GitHub Enterprise Cloud. Signed in with the GitHub CLI (<code className="font-mono">gh auth login</code>) or <code className="font-mono">COPILOT_GITHUB_TOKEN</code> instead? Choose Check again.
					{status.state === "unavailable" && status.message ? ` (${status.message})` : ""}
				</p>
			)}
		</div>
	);
}
