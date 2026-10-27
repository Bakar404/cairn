import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { subscriptionLabel, subscriptionLabels, isSubscriptionModel, type TurnUsage } from "../src/core/index.ts";
import { sessionCost, callCost } from "../src/server/pricing.ts";
import { graphCostSummary } from "../src/core/cost-summary.ts";
import { planCostLabel } from "../components/usage-format.ts";
import { StatsBar } from "../components/stats-bar.tsx";
import { ModelMenuList } from "../components/settings/model-menu.tsx";
import { toModelDto } from "../src/server/model-catalog.ts";
import { copilotModels, installCopilotRuntime } from "../src/agent/copilot/index.ts";
import { copilotInfo, idleCopilotRuntime } from "./fixtures/copilot.ts";
const step = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: undefined, cacheWriteTokens: undefined, reasoningTokens: undefined };
const turn = (model: string, id: string): TurnUsage => ({ id, messageId: id, at: "2026-10-24T00:00:00Z", model, steps: [step] });

test("only GitHub Copilot route IDs count as subscription use; the label stays compact and unique", () => {
	assert.equal(subscriptionLabel("copilot:gpt-5"), "GitHub Copilot");
	for (const model of ["openai:gpt-5", "chatgpt:gpt-5", "github-copilot:fixture", "github-copilot-subscription:fixture", "xai-subscription:grok", undefined]) {
		assert(!isSubscriptionModel(model), String(model));
	}
	assert.deepEqual(subscriptionLabels(["copilot:a", "openai:b", "copilot:c"]), ["GitHub Copilot"]);
	assert.equal(planCostLabel(0.12, ["GitHub Copilot"], (n) => `$${n.toFixed(2)}`), "$0.12 + GitHub Copilot");
	assert.equal(planCostLabel(null, ["GitHub Copilot", "GitHub Copilot"]), "GitHub Copilot");
	assert.equal(planCostLabel(null, undefined), "—");
});
test("mixed session pricing sums only API dollars and keeps Copilot turns out of the unpriced count", () => {
	const turns = [turn("copilot:gpt-5", "copilot"), turn("copilot:claude-sonnet-5", "copilot-2"), turn("openai:gpt-5", "api")];
	const pricing = sessionCost({ turns }); assert.equal(pricing.subscription, 2); assert.equal(pricing.unpriced, 0); assert.equal(pricing.cost, callCost(step, "openai:gpt-5"));
	assert.deepEqual(pricing.subscriptionProviders, ["GitHub Copilot"]);
	const html = renderToStaticMarkup(<StatsBar turns={turns} pricing={pricing} />);
	assert.match(html, /\$[\d.]+ \+ GitHub Copilot/); assert(!html.includes(" API +"));
});
test("graph stage/recent aggregates keep the Copilot subscription without inventing dollars", () => {
	const summary = graphCostSummary({ chats: [{ title: "Fixture", extractions: [{ startedAt: 1, at: "2026-10-24T00:00:00Z", durationMs: 1, stages: { extractor: { model: "copilot:gpt-5", steps: [step] }, auditor: { model: "copilot:claude-haiku-4.5", steps: [step] } } }] }], sources: [] }, callCost);
	assert.equal(summary.totalDollars, 0); assert.equal(summary.unpricedRuns, 0); assert.equal(summary.runs[0]!.dollars, null);
	assert.deepEqual(summary.subscriptionProviders, ["GitHub Copilot"]); assert.deepEqual(summary.runs[0]!.subscriptionProviders, ["GitHub Copilot"]);
});
test("model menu shows the Copilot subscription label rather than API prices", () => {
	installCopilotRuntime(idleCopilotRuntime, {
		status: { state: "signed-in", login: "octo" },
		models: [copilotInfo("claude-sonnet-5", { prices: { input: 300, output: 1500 } })],
	});
	try {
		const html = renderToStaticMarkup(<ModelMenuList models={copilotModels().map(toModelDto)} effectiveId={undefined} onPick={() => {}} />);
		assert(html.includes("GitHub Copilot (subscription)")); assert(html.includes(">GitHub Copilot</span>")); assert(!html.includes("USD per 1M")); assert(!html.includes("$"));
	} finally {
		installCopilotRuntime(undefined);
	}
});
