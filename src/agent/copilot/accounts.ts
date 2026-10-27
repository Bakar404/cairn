/**
 * In-app GitHub Copilot sign-in and account switching, through the Copilot
 * runtime's own account manager: the same browser sign-in the Copilot CLI
 * uses, with the credential kept by the runtime in the system keychain.
 * Cairn never sees or stores a token; accounts reach the browser as login,
 * host and an opaque selection id only.
 *
 * Personal and Enterprise Managed (EMU) accounts on github.com sign in at
 * github.com; accounts on a GitHub Enterprise Cloud host (*.ghe.com) give
 * that address first.
 *
 * One sign-in runs at a time. The runtime's advance call blocks until the
 * browser reaches its loopback callback, so it runs in the background and
 * the browser polls the flow; a sign-in left waiting is cancelled after
 * ten minutes.
 */
import type { CopilotAccount, CopilotAccounts, CopilotLogin, CopilotLoginProvider, CopilotLoginStep } from "../../core/contracts/copilot.ts";
import { copilotDebug, copilotRuntime, refreshCopilot, type CopilotAccountsPort, type RuntimeLoginStep } from "./runtime.ts";

const FLOW_TTL_MS = 10 * 60_000;
/** Pause before asking again after a step that does not block. */
const RECHECK_MS = 500;
/** Microsoft 365 inference identities: not GitHub accounts to switch to. */
const HIDDEN_KINDS = new Set(["loki"]);

/** A request that cannot apply (unknown account, bad address, stale
 *  sign-in): the caller's to fix, a 400. */
export class CopilotAccountError extends Error {}

/** What a waiting sign-in step accepts. */
export type CopilotLoginInput = { host: string } | { account: string } | { consent: true };

interface Flow {
	id: string;
	provider: CopilotLoginProvider;
	step: CopilotLoginStep;
	url?: string;
	/** Selection ids the runtime offered at choose-account. */
	choices: Set<string>;
	/** An advance call is in flight. */
	busy: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

const STATE_KEY = Symbol.for("cairn.copilot.login");

interface LoginState {
	flow?: Flow;
	/** The start in progress: starts run one at a time. */
	starting?: Promise<unknown>;
}
type Holder = typeof globalThis & { [STATE_KEY]?: LoginState };

/** Survives dev hot reloads, like the runtime itself. */
function loginState(): LoginState {
	const holder = globalThis as Holder;
	holder[STATE_KEY] ??= {};
	return holder[STATE_KEY];
}

async function accountsPort(): Promise<CopilotAccountsPort> {
	const port = await copilotRuntime();
	if (!port.accounts) throw new Error("This GitHub Copilot runtime cannot sign in from Cairn.");
	return port.accounts;
}

function settled(step: CopilotLoginStep): boolean {
	return step.state === "signed-in" || step.state === "failed" || step.state === "cancelled";
}

function live(flow: Flow): boolean {
	return loginState().flow === flow && !settled(flow.step);
}

function view(flow: Flow): CopilotLogin {
	return { id: flow.id, provider: flow.provider, step: flow.step };
}

function finish(flow: Flow, step: CopilotLoginStep): void {
	flow.step = step;
	if (flow.timer) clearTimeout(flow.timer);
	flow.timer = undefined;
}

/** Runtime errors arrive as "Request … failed with message: GenericFailure, <reason>". */
export function loginErrorText(err: unknown): string {
	const raw = err instanceof Error ? err.message : String(err);
	const text = raw.replace(/^[\s\S]*failed with message:\s*/, "").replace(/^GenericFailure,\s*/, "").trim();
	// GitHub sends error=access_denied, and the runtime prefers its error_description when present.
	if (/access_denied|denied your application access/i.test(text)) return "GitHub sign-in was cancelled in the browser.";
	// A sign-in lives on the runtime session that began it.
	if (/Unknown or completed login flow|Session not found|belongs to a different session/i.test(text)) return "This sign-in is no longer active. Start again.";
	return text || "GitHub sign-in failed.";
}

/** "contoso", "contoso.ghe.com" or "https://contoso.ghe.com/" →
 *  "https://contoso.ghe.com". Only GitHub Enterprise Cloud hosts. */
export function gheHost(raw: string): string {
	let host = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
	if (/^[a-z0-9-]+$/.test(host)) host = `${host}.ghe.com`;
	if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com$/.test(host)) {
		throw new CopilotAccountError("Enter your GitHub Enterprise Cloud address, like your-company.ghe.com.");
	}
	return `https://${host}`;
}

/** Waits on the runtime in the background (the browser callback). */
function wait(flow: Flow, delayMs = 0): void {
	if (flow.busy) return;
	flow.busy = true;
	void (async () => {
		if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
		let step: RuntimeLoginStep;
		try {
			if (!live(flow)) return;
			step = await (await accountsPort()).advance(flow.id);
		} catch (err) {
			if (live(flow)) finish(flow, { state: "failed", message: loginErrorText(err) });
			return;
		} finally {
			flow.busy = false;
		}
		await apply(flow, step);
	})().catch((err: unknown) => copilotDebug(`sign-in wait failed: ${String(err)}`));
}

async function apply(flow: Flow, step: RuntimeLoginStep): Promise<void> {
	if (!live(flow)) return;
	switch (step.kind) {
		case "open-url":
			flow.url = step.url;
			flow.step = { state: "browser", url: step.url };
			wait(flow);
			return;
		case "awaiting":
		case "needs-interaction":
			flow.step = { state: "browser", ...(flow.url ? { url: flow.url } : {}) };
			wait(flow, RECHECK_MS);
			return;
		case "input-required":
			flow.step = { state: "needs-host" };
			return;
		case "error":
			finish(flow, { state: "failed", message: loginErrorText(step.message) });
			return;
		case "completed": {
			const { status, login, host, accounts } = step.result;
			if (status === "completed") {
				// Status first, so a poller that sees "signed-in" also reads it.
				await refreshCopilot({ force: true });
				if (live(flow)) finish(flow, { state: "signed-in", ...(login ? { login } : {}), ...(host ? { host } : {}) });
				return;
			}
			if (status === "needs-account-selection" && accounts?.length) {
				flow.choices = new Set(accounts.map((a) => a.selectionId));
				flow.step = { state: "choose-account", accounts: accounts.map((a) => ({ id: a.selectionId, login: a.login, host: a.host })) };
				return;
			}
			if (status === "needs-plaintext-consent") {
				flow.step = { state: "needs-consent" };
				return;
			}
			finish(flow, { state: "failed", message: status === "declined" ? "The sign-in was not saved." : `GitHub sign-in stopped unexpectedly (${status}).` });
		}
	}
}

/** Best effort: the runtime drops the flow and closes its callback listener. */
async function cancelRuntimeFlow(id: string): Promise<void> {
	try {
		await (await accountsPort()).cancel(id);
	} catch (err) {
		copilotDebug(`sign-in cancel failed: ${String(err)}`);
	}
}

async function cancelFlow(flow: Flow): Promise<void> {
	finish(flow, { state: "cancelled" });
	await cancelRuntimeFlow(flow.id);
}

/** Any sign-in still unfinished, current or not, so none outlives its time. */
async function expire(flow: Flow): Promise<void> {
	if (settled(flow.step)) return;
	finish(flow, { state: "failed", message: "The sign-in timed out. Start again." });
	await cancelRuntimeFlow(flow.id);
}

/** Start a sign-in, cancelling one still in progress. Overlapping starts
 *  (two tabs) run one after the other, so none is left running untracked. */
export async function startCopilotLogin(provider: CopilotLoginProvider): Promise<CopilotLogin> {
	const s = loginState();
	const previous = s.starting;
	const run = (async () => {
		await previous?.catch(() => undefined);
		return beginLogin(provider);
	})();
	s.starting = run;
	try {
		return await run;
	} finally {
		if (s.starting === run) s.starting = undefined;
	}
}

async function beginLogin(provider: CopilotLoginProvider): Promise<CopilotLogin> {
	const s = loginState();
	if (s.flow && !settled(s.flow.step)) await cancelFlow(s.flow);
	const begun = await (await accountsPort()).begin(provider === "ghe" ? "proxima" : "githubDotCom");
	const flow: Flow = { id: begun.flowId, provider, step: { state: "browser" }, choices: new Set(), busy: false };
	flow.timer = setTimeout(() => void expire(flow), FLOW_TTL_MS);
	flow.timer.unref?.();
	s.flow = flow;
	await apply(flow, begun.step);
	return view(flow);
}

function currentFlow(id: string): Flow {
	const flow = loginState().flow;
	if (!flow || flow.id !== id) throw new CopilotAccountError("This sign-in is no longer active. Start again.");
	return flow;
}

/** The sign-in by id, or (no id) the one still in progress. */
export function copilotLogin(id?: string): CopilotLogin | undefined {
	const flow = loginState().flow;
	if (!flow) return undefined;
	if (id === undefined) return settled(flow.step) ? undefined : view(flow);
	return flow.id === id ? view(flow) : undefined;
}

/** Answer the step the sign-in waits on: the *.ghe.com address, the
 *  account to use, or consent to save without a keychain. */
export async function continueCopilotLogin(id: string, input: CopilotLoginInput): Promise<CopilotLogin> {
	const flow = currentFlow(id);
	let value: string;
	if ("host" in input) {
		if (flow.step.state !== "needs-host") throw new CopilotAccountError("This sign-in is not waiting for an address.");
		value = gheHost(input.host);
	} else if ("account" in input) {
		if (flow.step.state !== "choose-account" || !flow.choices.has(input.account)) throw new CopilotAccountError("Choose one of the offered accounts.");
		value = input.account;
	} else {
		if (flow.step.state !== "needs-consent") throw new CopilotAccountError("This sign-in is not waiting for consent.");
		value = "allow";
	}
	if (flow.busy) throw new CopilotAccountError("Still working on the last step.");
	flow.busy = true;
	let step: RuntimeLoginStep;
	try {
		step = await (await accountsPort()).advance(flow.id, value);
	} catch (err) {
		if (live(flow)) finish(flow, { state: "failed", message: loginErrorText(err) });
		return view(flow);
	} finally {
		flow.busy = false;
	}
	await apply(flow, step);
	return view(flow);
}

export async function cancelCopilotLogin(id: string): Promise<CopilotLogin> {
	const flow = currentFlow(id);
	if (!settled(flow.step)) await cancelFlow(flow);
	return view(flow);
}

/** The accounts the runtime can use, and the active one's Copilot plan. */
export async function copilotAccounts(): Promise<CopilotAccounts> {
	const port = await accountsPort();
	const [list, plan] = await Promise.all([port.list(), port.plan().catch(() => undefined)]);
	const accounts: CopilotAccount[] = list
		.filter((a) => !HIDDEN_KINDS.has(a.kind))
		.map((a) => ({ id: a.selectionId, login: a.login, host: a.host, active: a.active, ...(a.authSource ? { source: a.authSource } : {}) }));
	return { accounts, ...(plan && accounts.some((a) => a.active) ? { plan } : {}) };
}

async function knownAccount(id: string): Promise<CopilotAccount> {
	const account = (await copilotAccounts()).accounts.find((a) => a.id === id);
	if (!account) throw new CopilotAccountError("That account is no longer signed in.");
	return account;
}

/** Make an account the one every model call runs on. */
export async function switchCopilotAccount(id: string): Promise<CopilotAccounts> {
	const account = await knownAccount(id);
	if (!account.active) {
		await (await accountsPort()).switchTo(account.id);
		await refreshCopilot({ force: true });
	}
	return copilotAccounts();
}

/** Remove a sign-in the runtime saved. Sign-ins found elsewhere (the
 *  GitHub CLI, an environment token) are left to their owner. */
export async function signOutCopilotAccount(id: string): Promise<CopilotAccounts> {
	const account = await knownAccount(id);
	if (account.source) {
		throw new CopilotAccountError(
			account.source === "gh" ? "This account comes from the GitHub CLI; sign it out there with gh auth logout." : `This account comes from ${account.source}; remove it there.`,
		);
	}
	await (await accountsPort()).logout(account.id);
	await refreshCopilot({ force: true });
	return copilotAccounts();
}
