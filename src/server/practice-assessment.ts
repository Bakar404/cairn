/**
 * The answer check's trigger (M24). When a practice turn settles, every
 * problem that turn concluded gets one independent grade: the pure input
 * (core/practice-assessment.ts), one cheap-slot model call
 * (agent/subagents/assessor.ts), then an append to the record's
 * assessments log and a record-changed event so an open transcript
 * refetches and the conclude card can show the result.
 *
 * Best-effort by design: a second opinion, never a gate. The check is
 * skipped when it is switched off, when no cheap model or key is set up,
 * or when the model fails; nothing is retried, and errors are logged,
 * never thrown. Only the conclude calls of the settling turn are checked,
 * so reopening an old session never starts a burst of retroactive checks.
 */
import type { PracticeAssessment } from "../core/contracts.ts";
import { emit } from "../core/events.ts";
import {
	assessmentAgrees,
	assessmentInputFor,
	unansweredAssessment,
	type AssessmentInput,
} from "../core/practice-assessment.ts";
import { assessorEnabled, resolveRoleSpec } from "../core/settings-resolution.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { runAssessor, type AssessorResult } from "../agent/subagents/assessor.ts";
import { providerKeyPresent } from "./keys.ts";
import { effectiveSettings, stores } from "./stores.ts";

export interface AssessmentDeps {
	/** The model run. Tests inject a scripted one; null = no check. */
	assess?: (input: AssessmentInput, chatId: string) => Promise<AssessorResult | null>;
	now?: () => string;
}

interface AssessmentGlobal {
	__cairnAssessing?: Set<string>;
}

/** Checks in flight, process-wide (globalThis: Next dev compiles each
 *  route entry as its own module instance). */
function inFlight(): Set<string> {
	const g = globalThis as typeof globalThis & AssessmentGlobal;
	return (g.__cairnAssessing ??= new Set());
}

/** Whether a check on this session is still running. The eval runner
 *  (M23) waits these out before it grades a session. */
export function assessmentsInFlight(chatId: string): boolean {
	for (const key of inFlight()) if (key.startsWith(`${chatId}:`)) return true;
	return false;
}

/** The cheap-slot engine, or undefined when no model or key is set up. */
function assessorEngine(): PiEngine | undefined {
	const spec = resolveRoleSpec("assessor", stores.settingsStore.readSettings());
	if (!spec || !providerKeyPresent(spec.provider)) return undefined;
	try {
		return piEngineForSpec(spec);
	} catch {
		return undefined;
	}
}

async function defaultAssess(input: AssessmentInput, chatId: string): Promise<AssessorResult | null> {
	const engine = assessorEngine();
	return engine ? runAssessor(input, { engine, chatId }) : null;
}

/** Check the given conclude calls of one practice session, in order.
 *  Resolves with the entries it wrote; never rejects. */
export async function triggerAssessments(
	chatId: string,
	concludeCallIds: readonly string[],
	deps: AssessmentDeps = {},
): Promise<PracticeAssessment[]> {
	const written: PracticeAssessment[] = [];
	if (concludeCallIds.length === 0) return written;
	try {
		if (!assessorEnabled(effectiveSettings())) return written;
	} catch (err) {
		console.warn(`[assessor] settings unreadable, skipping: ${err instanceof Error ? err.message : String(err)}`);
		return written;
	}
	const now = deps.now ?? (() => new Date().toISOString());
	const assess = deps.assess ?? defaultAssess;
	for (const concludeCallId of concludeCallIds) {
		const key = `${chatId}:${concludeCallId}`;
		if (inFlight().has(key)) continue;
		inFlight().add(key);
		try {
			const record = stores.chatStore.getChat(chatId);
			if (!record || record.kind !== "practice") break;
			if (record.assessments?.some((a) => a.concludeCallId === concludeCallId)) continue;
			const input = assessmentInputFor(record.messages, concludeCallId);
			if (!input) continue;
			let entry: PracticeAssessment;
			if (input.answers.length === 0) {
				entry = unansweredAssessment(input, now());
			} else {
				const result = await assess(input, chatId);
				if (!result) continue;
				entry = {
					concludeCallId,
					problemCallId: input.problemCallId,
					at: now(),
					outcome: input.outcome,
					judgment: result.judgment,
					reason: result.reason,
					agrees: assessmentAgrees(input.outcome, result.judgment),
					...(result.model ? { model: result.model } : {}),
					steps: result.steps,
				};
			}
			stores.chatStore.appendAssessment(chatId, entry);
			written.push(entry);
			emit("record-changed", { chatId });
		} catch (err) {
			console.warn(`[assessor] ${chatId} ${concludeCallId}: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			inFlight().delete(key);
		}
	}
	return written;
}
