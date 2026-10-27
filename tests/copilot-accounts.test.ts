/**
 * In-app GitHub Copilot sign-in: the flow over the runtime's account
 * manager (a fake here), the accounts the browser sees, the HTTP routes,
 * and the SDK adapter's credential boundary.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { CopilotSession, GetAuthStatusResponse } from "@github/copilot-sdk";
import { cancelCopilotLogin, continueCopilotLogin, CopilotAccountError, copilotAccounts, copilotLogin, gheHost, loginErrorText, signOutCopilotAccount, startCopilotLogin, switchCopilotAccount } from "../src/agent/copilot/accounts.ts";
import { copilotStatus, installCopilotRuntime, sdkAccounts, type CopilotAccountsPort, type RuntimeAccount, type RuntimeLoginStep } from "../src/agent/copilot/runtime.ts";
import * as loginRoute from "../app/api/copilot/login/route.ts";
import * as accountsRoute from "../app/api/copilot/accounts/route.ts";
import { idleCopilotRuntime } from "./fixtures/copilot.ts";

const GITHUB_URL = "https://github.com/login/oauth/authorize?client_id=Iv1.test&state=abc";
const OCTOCAT: RuntimeAccount = { selectionId: "s1", login: "octocat", host: "https://github.com", kind: "githubDotCom", active: true };

interface Pending {
	flowId: string;
	input?: string;
	resolve(step: RuntimeLoginStep): void;
	reject(err: Error): void;
}

/** The runtime's account manager: advance calls stay pending until the
 *  test answers them, like the real one waiting on the browser. */
class FakeAccounts implements CopilotAccountsPort {
	roster: RuntimeAccount[] = [];
	planName: string | undefined = "enterprise";
	began: string[] = [];
	advances: Pending[] = [];
	cancelled: string[] = [];
	switched: string[] = [];
	loggedOut: string[] = [];
	authCalls = 0;
	/** Holds status reads until released. */
	authGate?: Promise<void>;
	private flows = 0;

	async list() {
		return this.roster.map((a) => ({ ...a }));
	}
	async plan() {
		return this.planName;
	}
	async begin(kind: "githubDotCom" | "proxima") {
		this.began.push(kind);
		const step: RuntimeLoginStep = kind === "proxima" ? { kind: "input-required", prompt: "Enter your GitHub Enterprise Cloud host (e.g. https://your-tenant.ghe.com)" } : { kind: "open-url", url: GITHUB_URL };
		return { flowId: `flow-${++this.flows}`, step };
	}
	advance(flowId: string, input?: string) {
		return new Promise<RuntimeLoginStep>((resolve, reject) => {
			this.advances.push({ flowId, ...(input !== undefined ? { input } : {}), resolve, reject });
		});
	}
	async cancel(flowId: string) {
		this.cancelled.push(flowId);
	}
	async switchTo(selectionId: string) {
		this.switched.push(selectionId);
		this.roster = this.roster.map((a) => ({ ...a, active: a.selectionId === selectionId }));
	}
	async logout(selectionId: string) {
		this.loggedOut.push(selectionId);
		this.roster = this.roster.filter((a) => a.selectionId !== selectionId);
	}
	async auth(): Promise<GetAuthStatusResponse> {
		this.authCalls++;
		await this.authGate;
		const active = this.roster.find((a) => a.active);
		return active ? { isAuthenticated: true, login: active.login, host: active.host, authType: "user" } : { isAuthenticated: false, statusMessage: "Not signed in" };
	}
}

let fake: FakeAccounts;

function install(roster: RuntimeAccount[] = []): void {
	fake = new FakeAccounts();
	fake.roster = roster;
	installCopilotRuntime({ ...idleCopilotRuntime, authStatus: () => fake.auth(), listModels: async () => [], accounts: fake }, { status: { state: "signed-out" } });
}

async function until(check: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (check()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.fail(`timed out waiting for ${what}`);
}

const stepOf = (id: string) => copilotLogin(id)?.step;

/** The n-th runtime advance call, answered by the test. */
function advance(n: number): Pending {
	const pending = fake.advances[n];
	assert.ok(pending, `advance ${n} was called`);
	return pending;
}

afterEach(() => {
	delete (globalThis as Record<symbol, unknown>)[Symbol.for("cairn.copilot.login")];
	installCopilotRuntime(undefined);
});

describe("Copilot sign-in flow", () => {
	it("github.com: hands out the authorize URL, waits on the runtime in the background, and says signed-in only once the status does", async () => {
		install();
		const started = await startCopilotLogin("github");
		assert.deepEqual(started, { id: "flow-1", provider: "github", step: { state: "browser", url: GITHUB_URL } });
		assert.deepEqual(fake.began, ["githubDotCom"]);
		assert.deepEqual(copilotLogin(), started, "an unfinished sign-in is found without its id");
		await until(() => fake.advances.length === 1, "the background wait");
		assert.equal(advance(0).input, undefined);

		let release!: () => void;
		fake.authGate = new Promise((resolve) => (release = resolve));
		fake.roster = [OCTOCAT];
		advance(0).resolve({ kind: "completed", result: { status: "completed", login: "octocat", host: "https://github.com" } });
		await until(() => fake.authCalls > 0, "the status refresh");
		assert.equal(stepOf("flow-1")?.state, "browser", "not signed-in before the status is");
		release();
		await until(() => stepOf("flow-1")?.state === "signed-in", "signed-in");
		assert.deepEqual(stepOf("flow-1"), { state: "signed-in", login: "octocat", host: "https://github.com" });
		assert.deepEqual(copilotStatus(), { state: "signed-in", login: "octocat", host: "https://github.com", authType: "user" });
		assert.equal(copilotLogin(), undefined, "a finished sign-in is no longer in progress");
	});

	it("a browser denial, a bad code or a runtime error ends the sign-in with a readable message", async () => {
		install();
		await startCopilotLogin("github");
		await until(() => fake.advances.length === 1, "the background wait");
		advance(0).reject(new Error("Request session.accounts.login.advance failed with message: GenericFailure, access_denied"));
		await until(() => stepOf("flow-1")?.state === "failed", "the failure");
		assert.deepEqual(stepOf("flow-1"), { state: "failed", message: "GitHub sign-in was cancelled in the browser." });

		await startCopilotLogin("github");
		await until(() => fake.advances.length === 2, "the background wait");
		advance(1).resolve({ kind: "error", message: "GenericFailure, Invalid URL" });
		await until(() => stepOf("flow-2")?.state === "failed", "the failure");
		assert.deepEqual(stepOf("flow-2"), { state: "failed", message: "Invalid URL" });

		await startCopilotLogin("github");
		await until(() => fake.advances.length === 3, "the background wait");
		advance(2).resolve({ kind: "completed", result: { status: "declined" } });
		await until(() => stepOf("flow-3")?.state === "failed", "the failure");
		assert.deepEqual(stepOf("flow-3"), { state: "failed", message: "The sign-in was not saved." });
		assert.equal(fake.authCalls, 0, "no status refresh for a sign-in that failed");

		assert.equal(loginErrorText(new Error("Request session.accounts.login.advance failed with message: GenericFailure, The code passed is incorrect or expired.")), "The code passed is incorrect or expired.");
		assert.equal(loginErrorText(new Error("Request session.accounts.login.advance failed with message: GenericFailure, Unknown or completed login flow")), "This sign-in is no longer active. Start again.");
		assert.equal(loginErrorText(new Error("Request session.accounts.login.advance failed with message: GenericFailure, The user has denied your application access.")), "GitHub sign-in was cancelled in the browser.");
		assert.equal(loginErrorText(new Error("Request session.accounts.login.advance failed with message: Session not found for sessionId: acct-1")), "This sign-in is no longer active. Start again.");
		assert.equal(loginErrorText(""), "GitHub sign-in failed.");
	});

	it("GitHub Enterprise Cloud: the runtime only ever sees a normalized *.ghe.com address", async () => {
		for (const [raw, host] of [
			["contoso", "https://contoso.ghe.com"],
			["contoso.ghe.com", "https://contoso.ghe.com"],
			[" HTTPS://Contoso.GHE.com/ ", "https://contoso.ghe.com"],
			["http://my-co.ghe.com", "https://my-co.ghe.com"],
		] as const) assert.equal(gheHost(raw), host, raw);
		for (const raw of ["", "github.com", "contoso.ghe.com.evil.com", "evil.com/contoso.ghe.com", "-contoso.ghe.com", "con toso", "contoso.ghe.com:8443", "user@contoso.ghe.com"]) {
			assert.throws(() => gheHost(raw), CopilotAccountError, raw);
		}

		install();
		const started = await startCopilotLogin("ghe");
		assert.deepEqual(started.step, { state: "needs-host" });
		assert.deepEqual(fake.began, ["proxima"]);
		await assert.rejects(continueCopilotLogin(started.id, { host: "github.com" }), CopilotAccountError);
		await assert.rejects(continueCopilotLogin(started.id, { account: "s1" }), /offered accounts/);
		await assert.rejects(continueCopilotLogin(started.id, { consent: true }), /not waiting for consent/);
		assert.equal(fake.advances.length, 0, "nothing reached the runtime");

		const answering = continueCopilotLogin(started.id, { host: "Contoso" });
		await until(() => fake.advances.length === 1, "the address");
		assert.equal(advance(0).input, "https://contoso.ghe.com");
		advance(0).resolve({ kind: "open-url", url: "https://contoso.ghe.com/login/oauth/authorize?client_id=x" });
		assert.deepEqual((await answering).step, { state: "browser", url: "https://contoso.ghe.com/login/oauth/authorize?client_id=x" });
		await until(() => fake.advances.length === 2, "the background wait");
		assert.equal(advance(1).input, undefined);
	});

	it("choose-account takes only an offered account, one answer at a time; consent answers 'allow'", async () => {
		install();
		await startCopilotLogin("github");
		await until(() => fake.advances.length === 1, "the background wait");
		advance(0).resolve({
			kind: "completed",
			result: {
				status: "needs-account-selection",
				accounts: [
					{ selectionId: "sel-a", login: "octocat", host: "https://github.com", kind: "githubDotCom" },
					{ selectionId: "sel-b", login: "octocat_contoso", host: "https://github.com", kind: "githubDotCom" },
				],
			},
		});
		await until(() => stepOf("flow-1")?.state === "choose-account", "choose-account");
		assert.deepEqual(stepOf("flow-1"), {
			state: "choose-account",
			accounts: [
				{ id: "sel-a", login: "octocat", host: "https://github.com" },
				{ id: "sel-b", login: "octocat_contoso", host: "https://github.com" },
			],
		});
		await assert.rejects(continueCopilotLogin("flow-1", { account: "sel-zzz" }), CopilotAccountError);

		const choosing = continueCopilotLogin("flow-1", { account: "sel-b" });
		await until(() => fake.advances.length === 2, "the choice");
		assert.equal(advance(1).input, "sel-b");
		await assert.rejects(continueCopilotLogin("flow-1", { account: "sel-a" }), /Still working/);
		advance(1).resolve({ kind: "completed", result: { status: "needs-plaintext-consent" } });
		assert.deepEqual((await choosing).step, { state: "needs-consent" });

		const consenting = continueCopilotLogin("flow-1", { consent: true });
		await until(() => fake.advances.length === 3, "the consent");
		assert.equal(advance(2).input, "allow");
		fake.roster = [{ ...OCTOCAT, selectionId: "sel-b", login: "octocat_contoso" }];
		advance(2).resolve({ kind: "completed", result: { status: "completed", login: "octocat_contoso", host: "https://github.com" } });
		assert.deepEqual((await consenting).step, { state: "signed-in", login: "octocat_contoso", host: "https://github.com" });
	});

	it("cancel stops the runtime's flow and its late answer changes nothing; a new sign-in replaces an unfinished one", async () => {
		install();
		const first = await startCopilotLogin("github");
		await until(() => fake.advances.length === 1, "the background wait");
		assert.deepEqual((await cancelCopilotLogin(first.id)).step, { state: "cancelled" });
		assert.deepEqual(fake.cancelled, ["flow-1"]);
		fake.roster = [OCTOCAT];
		advance(0).resolve({ kind: "completed", result: { status: "completed", login: "octocat" } });
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(stepOf(first.id), { state: "cancelled" });
		assert.equal(fake.authCalls, 0);
		assert.equal(copilotLogin(), undefined);

		const second = await startCopilotLogin("github");
		await until(() => fake.advances.length === 2, "the background wait");
		const third = await startCopilotLogin("ghe");
		assert.deepEqual(fake.cancelled, ["flow-1", "flow-2"]);
		assert.equal(copilotLogin(second.id), undefined, "replaced");
		assert.deepEqual(copilotLogin(), third);
		advance(1).reject(new Error("Request session.accounts.login.advance failed with message: GenericFailure, Unknown or completed login flow"));
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(stepOf(third.id), { state: "needs-host" });
		await assert.rejects(continueCopilotLogin(second.id, { host: "contoso" }), /no longer active/);
		await assert.rejects(cancelCopilotLogin(second.id), /no longer active/);
	});

	it("overlapping starts (two tabs) run one at a time, so no sign-in is left running untracked", async () => {
		install();
		const [first, second] = await Promise.all([startCopilotLogin("github"), startCopilotLogin("github")]);
		assert.deepEqual([first.id, second.id], ["flow-1", "flow-2"]);
		assert.deepEqual(fake.cancelled, ["flow-1"], "the earlier sign-in is cancelled in the runtime");
		assert.deepEqual(copilotLogin(), second);
		assert.equal(copilotLogin(first.id), undefined);
	});

	it("a sign-in left waiting is cancelled after ten minutes", async (t) => {
		install();
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const started = await startCopilotLogin("github");
		await until(() => fake.advances.length === 1, "the background wait");
		t.mock.timers.tick(10 * 60_000 - 1);
		assert.equal(stepOf(started.id)?.state, "browser");
		t.mock.timers.tick(1);
		assert.deepEqual(stepOf(started.id), { state: "failed", message: "The sign-in timed out. Start again." });
		await until(() => fake.cancelled.includes(started.id), "the runtime flow cancelled");
	});
});

describe("Copilot accounts", () => {
	it("reach the browser as id, login, host, active and source only; the plan only while an account is in use", async () => {
		install([
			{ ...OCTOCAT, authSource: "gh", token: "gho_secret" } as RuntimeAccount,
			{ selectionId: "s2", login: "mona", host: "https://contoso.ghe.com", kind: "proxima", active: false },
			{ selectionId: "s3", login: "m365-user", host: "https://m365.example", kind: "loki", active: false },
		]);
		const listed = await copilotAccounts();
		assert.deepEqual(listed, {
			accounts: [
				{ id: "s1", login: "octocat", host: "https://github.com", active: true, source: "gh" },
				{ id: "s2", login: "mona", host: "https://contoso.ghe.com", active: false },
			],
			plan: "enterprise",
		});
		assert.doesNotMatch(JSON.stringify(listed), /gho_|m365/);

		fake.plan = async () => {
			throw new Error("rpc failed");
		};
		assert.equal((await copilotAccounts()).plan, undefined, "a plan lookup failure still lists accounts");
		fake.plan = async () => "business";
		fake.roster = fake.roster.map((a) => ({ ...a, active: false }));
		assert.equal((await copilotAccounts()).plan, undefined);
	});

	it("switch and sign-out apply to known accounts only; sign-ins from the GitHub CLI or the environment stay with their owner", async () => {
		install([
			{ ...OCTOCAT, authSource: "gh" },
			{ selectionId: "s2", login: "mona", host: "https://contoso.ghe.com", kind: "proxima", active: false },
			{ selectionId: "s4", login: "hubot", host: "https://github.com", kind: "githubDotCom", active: false, authSource: "COPILOT_GITHUB_TOKEN" },
		]);
		await assert.rejects(switchCopilotAccount("gone"), CopilotAccountError);

		const switched = await switchCopilotAccount("s2");
		assert.deepEqual(fake.switched, ["s2"]);
		assert.deepEqual(switched.accounts.filter((a) => a.active).map((a) => a.login), ["mona"]);
		assert.deepEqual(copilotStatus(), { state: "signed-in", login: "mona", host: "https://contoso.ghe.com", authType: "user" }, "the status follows the switch");
		await switchCopilotAccount("s2");
		assert.deepEqual(fake.switched, ["s2"], "already in use: no runtime call");

		await assert.rejects(signOutCopilotAccount("s1"), /gh auth logout/);
		await assert.rejects(signOutCopilotAccount("s4"), /comes from COPILOT_GITHUB_TOKEN/);
		assert.deepEqual(fake.loggedOut, []);
		const after = await signOutCopilotAccount("s2");
		assert.deepEqual(fake.loggedOut, ["s2"]);
		assert.deepEqual(after.accounts.map((a) => a.id), ["s1", "s4"]);
		assert.equal(copilotStatus().state, "signed-out");
	});
});

describe("Copilot sign-in routes", () => {
	const request = (method: string, path: string, body?: unknown) =>
		new Request(`http://localhost${path}`, { method, ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });

	it("start, poll, answer and cancel a sign-in over HTTP, never cached", async () => {
		install();
		assert.equal((await loginRoute.POST(request("POST", "/api/copilot/login", { provider: "entra" }))).status, 400);
		assert.equal(await (await loginRoute.GET(request("GET", "/api/copilot/login"))).json(), null);

		const started = await loginRoute.POST(request("POST", "/api/copilot/login", { provider: "ghe" }));
		assert.equal(started.status, 200);
		assert.equal(started.headers.get("cache-control"), "no-store");
		const login = await started.json();
		assert.deepEqual(login, { id: "flow-1", provider: "ghe", step: { state: "needs-host" } });
		assert.deepEqual(await (await loginRoute.GET(request("GET", "/api/copilot/login"))).json(), login);
		assert.deepEqual(await (await loginRoute.GET(request("GET", "/api/copilot/login?id=flow-1"))).json(), login);
		assert.equal((await loginRoute.GET(request("GET", "/api/copilot/login?id=flow-9"))).status, 404);

		assert.equal((await loginRoute.PATCH(request("PATCH", "/api/copilot/login", { id: "flow-1" }))).status, 400);
		const badHost = await loginRoute.PATCH(request("PATCH", "/api/copilot/login", { id: "flow-1", host: "github.com" }));
		assert.equal(badHost.status, 400);
		assert.match((await badHost.json()).error, /ghe\.com/);
		assert.equal((await loginRoute.PATCH(request("PATCH", "/api/copilot/login", { id: "flow-9", host: "contoso" }))).status, 400);

		assert.equal((await loginRoute.DELETE(request("DELETE", "/api/copilot/login"))).status, 400);
		const cancelled = await loginRoute.DELETE(request("DELETE", "/api/copilot/login?id=flow-1"));
		assert.deepEqual((await cancelled.json()).step, { state: "cancelled" });
		assert.equal(await (await loginRoute.GET(request("GET", "/api/copilot/login"))).json(), null);
	});

	it("list, switch and sign out accounts over HTTP; a runtime that cannot sign in answers 503", async () => {
		install([{ ...OCTOCAT, authSource: "gh" }]);
		const listed = await accountsRoute.GET();
		assert.equal(listed.headers.get("cache-control"), "no-store");
		assert.deepEqual(await listed.json(), { accounts: [{ id: "s1", login: "octocat", host: "https://github.com", active: true, source: "gh" }], plan: "enterprise" });
		assert.equal((await accountsRoute.POST(request("POST", "/api/copilot/accounts", { action: "delete", id: "s1" }))).status, 400);
		const refused = await accountsRoute.POST(request("POST", "/api/copilot/accounts", { action: "sign-out", id: "s1" }));
		assert.equal(refused.status, 400);
		assert.match((await refused.json()).error, /gh auth logout/);

		installCopilotRuntime(idleCopilotRuntime, { status: { state: "signed-out" } });
		const unsupported = await accountsRoute.GET();
		assert.equal(unsupported.status, 503);
		assert.match((await unsupported.json()).error, /cannot sign in from Cairn/);
		assert.equal((await loginRoute.POST(request("POST", "/api/copilot/login", { provider: "github" }))).status, 503);
	});
});

describe("SDK account adapter", () => {
	const runtimeError = (method: string, reason: string) => new Error(`Request session.accounts.${method} failed with message: ${reason}`);

	/** A session whose account RPCs return more than Cairn may pass on. While
	 *  `gone` says so, every call fails the way the runtime's do for a session
	 *  it no longer has; `advance` can stand in for the sign-in step. */
	function fakeSession(n: number, log: string[], gone: () => boolean, advance?: () => Promise<unknown>): CopilotSession {
		const lost = (method: string) => {
			if (gone()) throw runtimeError(method, `Session not found for sessionId: acct-${n}`);
		};
		const accounts = {
			enumerate: async () => {
				lost("enumerate");
				return { kind: "accounts", items: [{ selectionId: "s1", login: "octocat", host: "https://github.com", kind: "githubDotCom", active: true, authSource: "gh", derivedFrom: "x", token: "gho_secret" }] };
			},
			get: async () => {
				lost("get");
				return { kind: "activeAccount", account: { login: "octocat" }, authInfo: { token: "gho_secret", copilotUser: { copilot_plan: log.includes("odd plan") ? "<b>enterprise</b>" : "enterprise" } } };
			},
			set: async ({ command }: { command: { kind: string; selectionId: string } }) => {
				lost("set");
				log.push(`${command.kind} ${command.selectionId}`);
				return { ok: command.selectionId !== "stale" };
			},
			login: {
				begin: async ({ kind }: { kind: string }) => {
					lost("login.begin");
					log.push(`begin acct-${n}`);
					return { flowId: `${kind}-1`, step: { kind: "open-url", url: GITHUB_URL, deviceCode: "ABCD-1234" } };
				},
				advance: async () => {
					lost("login.advance");
					log.push(`advance acct-${n}`);
					if (advance) return advance();
					return {
						kind: "completed",
						result: { status: "completed", login: "octocat", host: "https://github.com", token: "gho_secret", accounts: [{ selectionId: "s1", host: "https://github.com", login: "octocat", kind: "githubDotCom", token: "gho_other" }] },
					};
				},
				cancel: async () => {
					lost("login.cancel");
					log.push(`cancel acct-${n}`);
				},
			},
		};
		return { sessionId: `acct-${n}`, rpc: { accounts }, disconnect: async () => void log.push(`disconnect acct-${n}`) } as unknown as CopilotSession;
	}

	it("passes on only the fields Cairn uses, never authInfo, and reopens its session once when the runtime lost it", async () => {
		const log: string[] = [];
		let opened = 0;
		let lose = 0;
		const port = sdkAccounts(async () => {
			const n = ++opened;
			return fakeSession(n, log, () => lose > 0 && lose-- > 0);
		});

		assert.deepEqual(await port.list(), [{ selectionId: "s1", login: "octocat", host: "https://github.com", kind: "githubDotCom", active: true, authSource: "gh" }]);
		assert.equal(await port.plan(), "enterprise");
		log.push("odd plan");
		assert.equal(await port.plan(), undefined, "only a plain plan name passes");
		assert.deepEqual(await port.begin("githubDotCom"), { flowId: "githubDotCom-1", step: { kind: "open-url", url: GITHUB_URL } });
		assert.deepEqual(await port.advance("githubDotCom-1", "allow"), {
			kind: "completed",
			result: { status: "completed", host: "https://github.com", login: "octocat", accounts: [{ selectionId: "s1", host: "https://github.com", login: "octocat", kind: "githubDotCom" }] },
		});
		await port.switchTo("s1");
		await port.logout("s1");
		await assert.rejects(port.switchTo("stale"), /could not switch/);
		await assert.rejects(port.logout("stale"), /could not sign that account out/);
		assert.equal(opened, 1, "one session carries every call");

		lose = 1;
		assert.equal((await port.list()).length, 1);
		assert.equal(opened, 2, "reopened once");
		lose = 2;
		await assert.rejects(port.list(), /Session not found/, "not retried forever");
		assert.equal(opened, 3);
		assert.deepEqual(log.filter((line) => line.startsWith("disconnect")), ["disconnect acct-1", "disconnect acct-2", "disconnect acct-3"], "each lost session is let go");
		assert.equal((await port.list()).length, 1);
		assert.equal(await port.close(), "acct-4");
		assert.ok(log.includes("disconnect acct-4"));
		assert.deepEqual(log.filter((line) => /^(switchActive|logout)/.test(line)), ["switchActive s1", "logout s1", "switchActive stale", "logout stale"]);
	});

	it("keeps its session through sign-in errors, and never moves a sign-in to a new session", async () => {
		const log: string[] = [];
		const gone = new Set<number>();
		let opened = 0;
		let answer: () => Promise<unknown> = async () => {
			throw runtimeError("login.advance", "Unknown or completed login flow");
		};
		const port = sdkAccounts(async () => {
			const n = ++opened;
			return fakeSession(n, log, () => gone.has(n), () => answer());
		});

		await port.begin("githubDotCom");
		await assert.rejects(port.advance("githubDotCom-1"), /Unknown or completed login flow/);
		await port.cancel("githubDotCom-1");
		await port.begin("githubDotCom");
		assert.equal(opened, 1, "a sign-in error is not a lost session");

		// A sign-in waits on acct-1 while the runtime loses that session.
		let fail!: (err: Error) => void;
		answer = () => new Promise((_resolve, reject) => (fail = reject));
		const waiting = port.advance("githubDotCom-1");
		await until(() => typeof fail === "function", "the waiting sign-in step");
		gone.add(1);
		assert.equal((await port.list()).length, 1);
		assert.equal(opened, 2, "other calls move to a new session");
		fail(runtimeError("login.advance", "Session not found for sessionId: acct-1"));
		await assert.rejects(waiting, /Session not found/);
		await port.begin("githubDotCom");
		assert.equal(opened, 2, "the late failure neither retries the sign-in nor drops the new session");
		assert.deepEqual(log.filter((line) => line.startsWith("disconnect")), ["disconnect acct-1"], "the lost session is let go once");

		gone.add(2);
		await assert.rejects(port.advance("githubDotCom-1"), /Session not found/);
		assert.equal(opened, 2, "a sign-in step is not retried on a new session");
		assert.ok(log.includes("disconnect acct-2"));
		await port.cancel("githubDotCom-1");
		assert.equal(opened, 3, "the next call opens a new session");
		assert.deepEqual(log.filter((line) => /^(begin|advance|cancel)/.test(line)), ["begin acct-1", "advance acct-1", "cancel acct-1", "begin acct-1", "advance acct-1", "begin acct-2", "cancel acct-3"]);
	});
});
