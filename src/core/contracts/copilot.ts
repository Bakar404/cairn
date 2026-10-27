/** The GitHub Copilot sign-in state Cairn's model calls run on (GET/POST
 *  /api/copilot). Sign-in itself happens outside Cairn: the GitHub CLI
 *  (`gh auth login`), the Copilot CLI, or COPILOT_GITHUB_TOKEN. */
export type CopilotStatus =
	| { state: "signed-in"; login?: string; authType?: string; host?: string }
	| { state: "signed-out"; message?: string }
	| { state: "unavailable"; message: string }
	| { state: "unknown" };
