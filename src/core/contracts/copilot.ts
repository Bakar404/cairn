/** The GitHub Copilot sign-in state Cairn's model calls run on (GET/POST
 *  /api/copilot). Sign-in is the Copilot runtime's own: Cairn's "Sign in
 *  with GitHub" (/api/copilot/login), the GitHub CLI (`gh auth login`),
 *  the Copilot CLI, or COPILOT_GITHUB_TOKEN. */
export type CopilotStatus =
	| { state: "signed-in"; login?: string; authType?: string; host?: string }
	| { state: "signed-out"; message?: string }
	| { state: "unavailable"; message: string }
	| { state: "unknown" };

/** One GitHub account the Copilot runtime can use. Never carries a
 *  credential. */
export interface CopilotAccount {
	/** Opaque runtime selection id (switch / sign out). */
	id: string;
	login: string;
	/** "https://github.com" or a GitHub Enterprise Cloud host. */
	host: string;
	active: boolean;
	/** Where the sign-in comes from when Cairn did not save it ("gh",
	 *  "GITHUB_TOKEN", …). Absent: saved by a runtime sign-in (Cairn's or
	 *  the Copilot CLI's) — the only kind Cairn offers to sign out. */
	source?: string;
}

/** GET /api/copilot/accounts. */
export interface CopilotAccounts {
	accounts: CopilotAccount[];
	/** The active account's Copilot plan as GitHub names it ("enterprise",
	 *  "business", "individual", …). */
	plan?: string;
}

/** Where a sign-in happens: github.com (personal and Enterprise Managed
 *  accounts) or a GitHub Enterprise Cloud host (*.ghe.com). */
export type CopilotLoginProvider = "github" | "ghe";

/** Where an in-app sign-in stands (/api/copilot/login). */
export type CopilotLoginStep =
	/** Waiting on the browser: the user authorizes at `url`. */
	| { state: "browser"; url?: string }
	/** GitHub Enterprise Cloud: the *.ghe.com address is needed. */
	| { state: "needs-host" }
	/** Saved; the runtime asks which of these accounts to use. */
	| { state: "choose-account"; accounts: { id: string; login: string; host: string }[] }
	/** No system keychain: saving needs consent to a plaintext file. */
	| { state: "needs-consent" }
	| { state: "signed-in"; login?: string; host?: string }
	| { state: "failed"; message: string }
	| { state: "cancelled" };

export interface CopilotLogin {
	id: string;
	provider: CopilotLoginProvider;
	step: CopilotLoginStep;
}
