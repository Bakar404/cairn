/**
 * Shared GitHub Copilot doubles: runtime catalog entries in the SDK's
 * ModelInfo shape, and a runtime port that fails any call — for tests that
 * seed status and models up front (installCopilotRuntime) and expect no
 * runtime traffic.
 */
import type { ModelInfo } from "@github/copilot-sdk";
import type { CopilotRuntimePort } from "../../src/agent/copilot/index.ts";

export interface CopilotInfoOptions {
	vision?: boolean;
	/** Reasoning efforts; empty = a non-reasoning model. */
	efforts?: string[];
	context?: number;
	output?: number;
	/** AI credits per million tokens. */
	prices?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

export function copilotInfo(id: string, over: CopilotInfoOptions = {}): ModelInfo {
	const efforts = over.efforts ?? [];
	return {
		id,
		name: id,
		capabilities: {
			supports: { vision: over.vision ?? true, reasoningEffort: efforts.length > 0 },
			limits: { max_context_window_tokens: over.context ?? 200_000, max_output_tokens: over.output ?? 32_000 },
		},
		policy: { state: "enabled", terms: "" },
		billing: {
			multiplier: 1,
			...(over.prices
				? {
					tokenPrices: {
						inputPrice: over.prices.input,
						outputPrice: over.prices.output,
						cacheReadPrice: over.prices.cacheRead ?? 0,
						cacheWritePrice: over.prices.cacheWrite ?? 0,
						batchSize: 1_000_000,
					},
				}
				: {}),
		},
		...(efforts.length ? { supportedReasoningEfforts: efforts } : {}),
	} as unknown as ModelInfo;
}

export const idleCopilotRuntime: CopilotRuntimePort = {
	authStatus: async () => { throw new Error("unexpected Copilot status call"); },
	listModels: async () => { throw new Error("unexpected Copilot catalog call"); },
	createSession: async () => { throw new Error("unexpected Copilot session"); },
	deleteSession: async () => {},
	listSessions: async () => [],
	stop: async () => {},
};
