import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	catalogDefaultsFor,
	catalogProviders,
	catalogRolePins,
	catalogSlots,
	clampChatLevel,
	clampModelsLevels,
	modelCatalog,
	rolePinsFor,
	toModelDto,
	validateChatSettings,
	validateModelsSettings,
} from "../src/server/model-catalog.ts";
import type { EffectiveSlot } from "../src/core/settings-resolution.ts";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { DEFAULT_THINKING_ORDER } from "../src/core/settings.ts";
import { piEngineForSpec } from "../src/agent/models.ts";
import { BACKGROUND_MODEL_ROLES } from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { readSettings } from "../src/store/settings.ts";
import { effectiveSettings } from "../src/server/stores.ts";
import { copilotModel, installCopilotRuntime } from "../src/agent/copilot/index.ts";
import { copilotInfo, idleCopilotRuntime } from "./fixtures/copilot.ts";

// The model-control wave (2026-09-12): the catalog is the signed-in user's
// GitHub Copilot models — these pins hold our projection + validation
// honest against a seeded Copilot catalog, and pin pi's per-model thinking
// truth on the projected models. BYOK wave (2026-09-22): no factory pins —
// unset surfaces are NULL/undefined, never phantom defaults.

const CATALOG = [
	// reasoning low|medium|high, vision, priced (AI credits per 1M tokens)
	copilotInfo("claude-sonnet-5", { efforts: ["low", "medium", "high"], prices: { input: 300, output: 1500, cacheRead: 30, cacheWrite: 375 } }),
	// reasoning low|high|xhigh — the clamp specimen
	copilotInfo("gpt-5.6-luna", { efforts: ["low", "high", "xhigh"], context: 400_000 }),
	// no reasoning, text only
	copilotInfo("claude-haiku-4.5", { vision: false }),
];
const SIGNED_IN = { status: { state: "signed-in" as const, login: "octo" }, models: CATALOG };

before(() => installCopilotRuntime(idleCopilotRuntime, SIGNED_IN));
after(() => installCopilotRuntime(undefined));

const copilot = (id: string) => ({ provider: "copilot", id });

function seeded(id: string) {
	const model = copilotModel(id);
	assert.ok(model, `${id} in the seeded catalog`);
	return model!;
}

describe("the model catalog projection", () => {
	it("serves the signed-in user's Copilot catalog with the picker's DTO shape", () => {
		const { models, defaults, providers, slots } = modelCatalog();
		assert.deepEqual(models.map((m) => m.id), ["claude-haiku-4.5", "claude-sonnet-5", "gpt-5.6-luna"]);
		for (const m of models) {
			assert.equal(m.provider, "copilot");
			assert.equal(typeof m.name, "string");
			assert.ok(Array.isArray(m.supportedLevels));
			assert.ok(typeof m.cost.input === "number" && typeof m.cost.output === "number");
			assert.ok(m.contextWindow > 0);
		}
		const sonnet = models.find((m) => m.id === "claude-sonnet-5")!;
		assert.deepEqual(sonnet.supportedLevels, ["low", "medium", "high"]);
		assert.deepEqual(sonnet.input, ["text", "image"]);
		// AI credits per million tokens → USD per million tokens
		assert.deepEqual(sonnet.cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
		const haiku = models.find((m) => m.id === "claude-haiku-4.5")!;
		assert.deepEqual(haiku.supportedLevels, ["off"]);
		assert.deepEqual(haiku.input, ["text"]);
		assert.deepEqual(providers, [{ id: "copilot", envVar: "", keyPresent: true }]);
		assert.deepEqual(Object.keys(slots), ["strong", "cheap", "vision"]);
		// BYOK: the payload carries ONLY what the machine's record actually
		// says — never a phantom id. data/settings.json belongs to
		// settings-store.test.ts (the one-fs-owner discipline), so READ the
		// resolved truth here instead of pinning it: on a scratch worktree
		// the record is empty (defaults/slots NULL), on the owner's machine
		// configured slots must surface exactly as configured.
		const record = readSettings();
		const strong = effectiveSettings().models.strong;
		if (strong) {
			assert.ok(defaults, "a configured strong slot yields a default");
			assert.deepEqual(defaults!.model, { provider: strong.provider, id: strong.id });
		} else {
			assert.equal(defaults, null);
		}
		for (const name of ["strong", "cheap", "vision"] as const) {
			const stored = record?.models?.[name];
			if (stored?.model) {
				assert.ok(slots[name], name);
				assert.deepEqual(slots[name]!.model, stored.model);
			} else {
				assert.equal(slots[name], null, name);
			}
		}
	});

	it("signed out: no models reach the picker and the connection row reads not connected", () => {
		installCopilotRuntime(idleCopilotRuntime, { status: { state: "signed-out" }, models: CATALOG });
		try {
			const { models, providers } = modelCatalog();
			assert.deepEqual(models, []);
			assert.deepEqual(providers, [{ id: "copilot", envVar: "", keyPresent: false }]);
		} finally {
			installCopilotRuntime(idleCopilotRuntime, SIGNED_IN);
		}
	});

	it("defaults: the strong slot verbatim; null when unset (BYOK, per-session models 2026-09-28)", () => {
		assert.equal(catalogDefaultsFor(null), null);
		const strong = { provider: "copilot", id: "claude-sonnet-5", thinkingLevel: "low" as const };
		const d = catalogDefaultsFor(strong);
		assert.deepEqual(d, { model: copilot("claude-sonnet-5"), thinkingLevel: "low" });
		// No level stored → the model alone reports (the level resolves at
		// engine build from DEFAULT_THINKING_ORDER).
		const bare = catalogDefaultsFor({ provider: "copilot", id: "gpt-5.6-luna" });
		assert.deepEqual(bare, { model: copilot("gpt-5.6-luna") });
	});

	it("toModelDto projects the raw catalog model verbatim", () => {
		const raw = seeded("gpt-5.6-luna");
		const dto = toModelDto(raw);
		assert.equal(dto.id, raw.id);
		assert.equal(dto.name, raw.name);
		assert.deepEqual(dto.supportedLevels, getSupportedThinkingLevels(raw));
		assert.equal(dto.cost.input, raw.cost.input);
		assert.equal(dto.contextWindow, 400_000);
	});
});

describe("the background roles' resolved pins (rolePins)", () => {
	it("no record → every role is NULL (BYOK: no phantom defaults)", () => {
		const pins = rolePinsFor(resolveSettings(null).agent.models);
		assert.deepEqual(Object.keys(pins), [...BACKGROUND_MODEL_ROLES]);
		for (const role of BACKGROUND_MODEL_ROLES) {
			assert.equal(pins[role], null, role);
		}
	});

	it("a slot re-tiers its roles; overrides win for that role only", () => {
		const record = {
			version: 1,
			models: { cheap: { model: copilot("claude-haiku-4.5") } },
			agent: { models: { researcher: { model: copilot("claude-sonnet-5"), thinkingLevel: "high" as const } } },
		};
		const pins = rolePinsFor(resolveSettings(record).agent.models);
		assert.deepEqual(pins.researcher, { model: copilot("claude-sonnet-5"), thinkingLevel: "high" });
		assert.deepEqual(pins.auditor, { model: copilot("claude-haiku-4.5") }); // level unset
		assert.equal(pins.visualMaker, null, "vision tier untouched");
	});

	it("catalogRolePins matches the same resolution the engine wiring uses", () => {
		const pins = catalogRolePins();
		for (const role of BACKGROUND_MODEL_ROLES) {
			assert.ok(pins[role] === null || typeof pins[role]!.model.id === "string");
		}
	});
});

describe("the model slots surface (model slots wave, 2026-09-20)", () => {
	it("catalogSlots projects the record's tiers — NULL only where a tier holds no model", () => {
		// machine-aware (one-fs-owner: READ the record, never pin it)
		const record = readSettings();
		const slots = catalogSlots();
		for (const name of ["strong", "cheap", "vision"] as const) {
			const stored = record?.models?.[name];
			if (stored?.model) {
				assert.ok(slots[name], name);
				assert.deepEqual(slots[name]!.model, stored.model);
			} else {
				assert.equal(slots[name], null, name);
			}
		}
	});

	it("catalogProviders reads the live Copilot connection, fresh per call", () => {
		assert.equal(catalogProviders()[0]?.keyPresent, true);
		installCopilotRuntime(idleCopilotRuntime, { status: { state: "signed-out" } });
		try {
			assert.equal(catalogProviders()[0]?.keyPresent, false);
		} finally {
			installCopilotRuntime(idleCopilotRuntime, SIGNED_IN);
		}
	});
});

describe("the models-section validation gate", () => {
	it("accepts a Copilot catalog model and rejects other providers and unknown ids", () => {
		assert.equal(validateModelsSettings({ strong: { model: copilot("claude-sonnet-5") } }).ok, true);
		const stale = validateModelsSettings({ cheap: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } } });
		assert.equal(stale.ok, false);
		assert.match(stale.ok ? "" : stale.error, /GitHub Copilot/);
		assert.equal(validateModelsSettings({ vision: { model: copilot("nope") } }).ok, false);
	});

	it("thinking levels never reject a slot write (owner, interlude 2026-09-22)", () => {
		// clamp, never reject: the model swap with a pinned level JUST
		// WORKS — validation accepts ANY level; the WRITE clamps to the
		// new model's nearest supported and stores the clamped result.
		assert.deepEqual(
			validateModelsSettings({ strong: { model: copilot("gpt-5.6-luna"), thinkingLevel: "minimal" } }),
			{ ok: true },
		);
		assert.deepEqual(
			validateModelsSettings({ strong: { model: copilot("claude-sonnet-5"), thinkingLevel: "max" } }),
			{ ok: true },
		);
	});

	it("clampModelsLevels: the slot's own model translates the pin (the owner's exact case)", () => {
		// a max pin moved onto luna (low|high|xhigh): the pin clamps to the
		// nearest supported and the CLAMPED value is stored.
		const luna = { model: copilot("gpt-5.6-luna"), thinkingLevel: "max" as const };
		assert.deepEqual(clampModelsLevels({ strong: luna }), {
			strong: { model: copilot("gpt-5.6-luna"), thinkingLevel: "xhigh" },
		});
		assert.deepEqual(clampModelsLevels({ strong: { ...luna, thinkingLevel: "minimal" as const } }).strong, {
			model: copilot("gpt-5.6-luna"),
			thinkingLevel: "low",
		});
		// luna cannot disable reasoning: off clamps UP to low
		assert.equal(
			clampModelsLevels({ strong: { ...luna, thinkingLevel: "off" as const } }).strong?.thinkingLevel,
			"low",
		);
		// a supported level passes through untouched
		assert.deepEqual(clampModelsLevels({ strong: { ...luna, thinkingLevel: "high" as const } }).strong, {
			model: copilot("gpt-5.6-luna"),
			thinkingLevel: "high",
		});
		// a slot with no level rides as-is (client populates on fresh
		// picks per DEFAULT_THINKING_ORDER — the server never invents one)
		assert.deepEqual(clampModelsLevels({ strong: { model: luna.model } }), {
			strong: { model: copilot("gpt-5.6-luna") },
		});
	});

	it("accepts empty settings (the clear-slots write)", () => {
		assert.deepEqual(validateModelsSettings({}), { ok: true });
	});
});

describe("the settings validation gate", () => {
	it("thinking levels never reject a chat write (owner, interlude 2026-09-22)", () => {
		assert.deepEqual(
			validateChatSettings({ model: copilot("gpt-5.6-luna"), thinkingLevel: "minimal" }),
			{ ok: true },
		);
		assert.deepEqual(validateChatSettings({ thinkingLevel: "xhigh" }), { ok: true });
	});

	it("clampChatLevel: the body's model, else the strong slot, translates the pin", () => {
		const strong: EffectiveSlot = { provider: "copilot", id: "gpt-5.6-luna" };
		// the body's own model wins (sonnet tops out at high)
		assert.deepEqual(
			clampChatLevel({ model: copilot("claude-sonnet-5"), thinkingLevel: "xhigh" as const }, strong),
			{ model: copilot("claude-sonnet-5"), thinkingLevel: clampThinkingLevel(seeded("claude-sonnet-5"), "xhigh") },
		);
		// no body model → the record's strong slot is the fallback (luna runs xhigh)
		assert.equal(clampChatLevel({ thinkingLevel: "max" as const }, strong).thinkingLevel, "xhigh");
		// no model anywhere → rides unchecked (runtime clamps; the turn
		// gate refuses the model-less chat anyway)
		assert.deepEqual(clampChatLevel({ thinkingLevel: "minimal" as const }, null), { thinkingLevel: "minimal" });
		// no pinned level → untouched
		assert.deepEqual(clampChatLevel({ model: copilot("gpt-5.6-luna") }, strong), { model: copilot("gpt-5.6-luna") });
	});

	it("rejects unknown providers and models", () => {
		assert.equal(validateChatSettings({ model: { provider: "nope", id: "x/y" } }).ok, false);
		assert.equal(validateChatSettings({ model: copilot("nope") }).ok, false);
	});

	it("accepts empty settings (the clear-overrides write)", () => {
		assert.deepEqual(validateChatSettings({}), { ok: true });
	});
});

describe("pi thinking truth on projected Copilot models", () => {
	it("luna: low|high|xhigh; anything else clamps to the nearest", () => {
		const luna = seeded("gpt-5.6-luna");
		assert.deepEqual(getSupportedThinkingLevels(luna), ["low", "high", "xhigh"]);
		assert.equal(clampThinkingLevel(luna, "minimal"), "low");
		assert.equal(clampThinkingLevel(luna, "off"), "low", "no \"none\" effort: reasoning cannot be disabled");
		assert.equal(clampThinkingLevel(luna, "max"), "xhigh");
		assert.equal(clampThinkingLevel(luna, "high"), "high");
	});

	it("the engine factory clamps explicit levels; unknown models and other providers throw honestly", () => {
		const over = piEngineForSpec({ provider: "copilot", id: "claude-sonnet-5", thinkingLevel: "high" });
		assert.equal(over.model.id, "claude-sonnet-5");
		assert.equal(over.level, "high");
		const clamped = piEngineForSpec({ provider: "copilot", id: "gpt-5.6-luna", thinkingLevel: "minimal" });
		assert.equal(clamped.level, "low");
		assert.throws(() => piEngineForSpec({ provider: "copilot", id: "nope", thinkingLevel: "low" }), /GitHub Copilot has no model nope/);
		assert.throws(() => piEngineForSpec({ provider: "openrouter", id: "z-ai/glm-5.3-flash" }), /GitHub Copilot only/);
	});

	it("UNSET levels resolve from the baked DEFAULT_THINKING_ORDER (owner, 2026-09-22)", () => {
		assert.deepEqual([...DEFAULT_THINKING_ORDER], ["medium", "low", "high", "minimal", "xhigh", "max"]);
		// first supported entry in the order
		assert.equal(piEngineForSpec(copilot("claude-sonnet-5")).level, "medium");
		assert.equal(piEngineForSpec(copilot("gpt-5.6-luna")).level, "low");
		// explicit levels never consult the order — pi clamps nearest
		assert.equal(piEngineForSpec({ ...copilot("gpt-5.6-luna"), thinkingLevel: "xhigh" }).level, "xhigh");
		// a non-reasoning model reports exactly ["off"] → the order lands there
		const flat = seeded("claude-haiku-4.5");
		assert.deepEqual(getSupportedThinkingLevels(flat), ["off"]);
		assert.equal(piEngineForSpec(copilot("claude-haiku-4.5")).level, "off");
	});

	it("the legacy piEngineFor role entry point throws honestly (BYOK: no pins)", async () => {
		const { piEngineFor } = await import("../src/agent/models.ts");
		assert.throws(() => piEngineFor("prober"), /no configured model for role "prober"/);
	});
});
