import {
	clampThinkingLevel,
	createModels,
	getSupportedThinkingLevels,
	type Api,
	type Model,
	type StreamFunction,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type ModelRole } from "../../config.ts";
import { DEFAULT_THINKING_ORDER } from "../core/settings.ts";
import packageMetadata from "../../package.json" with { type: "json" };
import { COPILOT_PROVIDER, copilotModel, copilotStream } from "./copilot/index.ts";

/** App identity is immutable and shared by Models and every native Agent.
 * Agent's default Pi attribution otherwise overrides the Models identity. */
export const APP_IDENTITY = Object.freeze({
	userAgent: Object.freeze({ custom: `cairn/${packageMetadata.version}` }),
	attribution: Object.freeze({ name: packageMetadata.name, url: packageMetadata.homepage }),
});

/**
 * The one engine factory every agent's model comes from (the pi-ai swap,
 * docs/pi-engine-swap.md). There are no factory pins: every engine
 * resolves from a RESOLVED SPEC (the settings chain's output).
 *
 * An "engine" is the model + the stream function the agent loop runs on —
 * the two things a test fake replaces. Every production engine runs on the
 * signed-in user's GitHub Copilot subscription (src/agent/copilot); no other
 * model connection exists.
 */

export interface PiEngine {
	model: Model<Api>;
	streamFn: StreamFunction;
	/** The resolved (config-or-settings, CLAMPED) thinking level —
	 *  observability + tests; the streamFn pins it anyway. */
	level?: ThinkingLevel;
}

export type { ThinkingLevel };

let collection: ReturnType<typeof createModels> | undefined;

/** pi-ai's static per-provider catalogs. Read-only here: pricing uses them
 *  to estimate API dollars for older records saved with a priced
 *  provider:model id. Nothing streams through these providers. */
export function piModels() {
	if (!collection) {
		collection = createModels({ identity: APP_IDENTITY });
		for (const provider of builtinProviders()) collection.setProvider(provider);
	}
	return collection;
}

/** A fully-resolved model pin — the shape every engine now comes from:
 *  the settings-resolution chain's output (role override → slot, or the
 *  chat's conversation chain). thinkingLevel is OPTIONAL: unset means
 *  the baked default resolves here (owner 2026-09-22) — the first entry
 *  of DEFAULT_THINKING_ORDER the model supports. */
export interface ResolvedModelSpec {
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
}

/** The first entry of the baked default order the model supports (owner,
 *  2026-09-22). A non-reasoning model reports exactly ["off"], so the
 *  order walk lands there naturally. */
function defaultThinkingLevel(model: Model<Api>): ThinkingLevel {
	const supported = getSupportedThinkingLevels(model);
	for (const level of DEFAULT_THINKING_ORDER) {
		if (supported.includes(level)) return level;
	}
	return supported[0] ?? "off";
}

/** The production engine for a RESOLVED spec: the Copilot catalog lookup +
 *  thinking clamp. Any other provider is refused — a stored pin from an
 *  older build surfaces as "model unavailable", never a silent fallback. */
export function piEngineForSpec(spec: ResolvedModelSpec): PiEngine {
	if (spec.provider !== COPILOT_PROVIDER) {
		throw new Error(`Cairn runs models through GitHub Copilot only (got provider "${spec.provider}")`);
	}
	const model = copilotModel(spec.id);
	if (!model) {
		throw new Error(`GitHub Copilot has no model ${spec.id}`);
	}
	// UNSET level → the baked default order (first entry the model
	// supports); SET level → pi's native nearest-clamp (model swaps keep
	// the user's intent and adapt honestly).
	const level = spec.thinkingLevel
		? clampThinkingLevel(model, spec.thinkingLevel)
		: defaultThinkingLevel(model);
	const stream = copilotStream();
	return {
		model,
		level,
		// The agent loop forwards state.thinkingLevel as `reasoning`
		// (undefined = off on pi-ai's scale); the clamp above keeps the pin
		// honest even when settings drift off the model's supported levels.
		streamFn: (requestModel, context, options) =>
			stream(requestModel, context, { ...options, reasoning: level === "off" ? undefined : level }),
	};
}

/** The LEGACY role entry point — BYOK made it an honest THROWER (owner,
 *  2026-09-22): no factory pins exist to fall back to, and this module
 *  cannot read settings (architecture law — the agent layer never
 *  imports the server layer). Production resolves the chain in
 *  chat-handler and ALWAYS injects engines; reaching this means a
 *  wiring bug, so it fails loudly instead of guessing a model. */
export function piEngineFor(role: ModelRole): PiEngine {
	throw new Error(
		`no configured model for role "${role}" — set your model slots (settings → models)`,
	);
}
