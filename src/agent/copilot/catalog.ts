/**
 * GitHub Copilot model catalog → pi models (pure).
 *
 * The Copilot runtime reports each model's limits, vision support,
 * reasoning efforts and AI-credit token prices; this module projects them
 * onto pi's Model shape so the picker, thinking clamps and context meters
 * keep reading one catalog type.
 */
import type { Api, Model, ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ModelInfo } from "@github/copilot-sdk";

export const COPILOT_PROVIDER = "copilot";
export const COPILOT_API = "github-copilot-sdk";
export const COPILOT_LABEL = "GitHub Copilot";

/** One AI credit is billed at $0.01. */
export const USD_PER_CREDIT = 0.01;
const FALLBACK_MAX_OUTPUT = 16_384;

type PiLevel = keyof ThinkingLevelMap;
const PI_LEVELS: readonly PiLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The runtime's reasoning efforts for a model ("none" disables reasoning). */
function reasoningEfforts(info: ModelInfo): string[] {
	if (!info.capabilities?.supports?.reasoningEffort) return [];
	return [...(info.supportedReasoningEfforts ?? [])];
}

/** pi level → Copilot effort; null marks a level the model cannot run. */
function thinkingLevelMap(efforts: readonly string[]): ThinkingLevelMap {
	const map: ThinkingLevelMap = {};
	for (const level of PI_LEVELS) {
		const effort = level === "off" ? "none" : level;
		map[level] = efforts.includes(effort) ? effort : null;
	}
	return map;
}

/** AI credits per `batchSize` tokens → USD per million tokens. */
function perMillion(credits: number | undefined, batchSize: number): number {
	if (typeof credits !== "number" || !Number.isFinite(credits) || credits < 0) return 0;
	return (credits * USD_PER_CREDIT * 1_000_000) / batchSize;
}

/** Project one runtime model; undefined for entries Cairn cannot run
 *  (the capability-less `auto` router, or models the user's policy has not
 *  enabled). */
export function toPiModel(info: ModelInfo): Model<Api> | undefined {
	const limits = info.capabilities?.limits;
	if (!limits?.max_context_window_tokens) return undefined;
	if (info.policy && info.policy.state !== "enabled") return undefined;
	const efforts = reasoningEfforts(info);
	const prices = info.billing?.tokenPrices;
	const batch = prices?.batchSize && prices.batchSize > 0 ? prices.batchSize : 1_000_000;
	const contextWindow = limits.max_prompt_tokens ?? limits.max_context_window_tokens;
	return {
		id: info.id,
		name: info.name || info.id,
		api: COPILOT_API,
		provider: COPILOT_PROVIDER,
		baseUrl: "",
		input: info.capabilities.supports?.vision ? ["text", "image"] : ["text"],
		cost: {
			input: perMillion(prices?.inputPrice, batch),
			output: perMillion(prices?.outputPrice, batch),
			cacheRead: perMillion(prices?.cacheReadPrice, batch),
			cacheWrite: perMillion(prices?.cacheWritePrice, batch),
		},
		reasoning: efforts.some((e) => e !== "none"),
		...(efforts.length ? { thinkingLevelMap: thinkingLevelMap(efforts) } : {}),
		contextWindow,
		maxTokens: limits.max_output_tokens ?? Math.min(FALLBACK_MAX_OUTPUT, contextWindow),
	};
}

export function toPiModels(infos: readonly ModelInfo[]): Model<Api>[] {
	return infos
		.map(toPiModel)
		.filter((m): m is Model<Api> => m !== undefined)
		.sort((a, b) => a.id.localeCompare(b.id));
}

/** The Copilot effort for a pi request level (undefined = pi "off"), or
 *  undefined to leave the model's own default in place. */
export function effortFor(model: Model<Api>, level: ThinkingLevel | undefined): string | undefined {
	return model.thinkingLevelMap?.[level ?? "off"] ?? undefined;
}
