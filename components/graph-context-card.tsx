"use client";

import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import type { GraphContextEvidence } from "@/src/core";
import { SourceEvidence } from "@/components/source-evidence";
import { cn } from "@/lib/utils";

/**
 * The graph-context card (owner, 2026-10-04): the session's map pick —
 * message[0] of a session started with propositions picked from the
 * graph. Scaffolding, not a turn: minimal, muted, collapsed by default;
 * expand reveals the picked propositions (name — statement), the source
 * evidence behind them (M22: a checked quote, with its page or diff hunk),
 * and the reasoning chains among them (premises → conclusion lines). The
 * model reads the same content through the marker's own text
 * (toLlmMessages); this card is the learner's face of it.
 */

/** The graph-context marker's details (native-messages.ts). */
export interface GraphContextData {
	propositions: { id: string; name: string; statement: string }[];
	chains: string[];
	/** Absent when no pick has a checked quote (and on older records). */
	evidence?: GraphContextEvidence[];
}

export function GraphContextCard({ data }: { data: GraphContextData }) {
	const [open, setOpen] = useState(false);
	const { propositions = [], chains = [], evidence = [] } = data ?? {};
	const evidenceFor = new Map(evidence.map((e) => [e.id, e]));
	const noun = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
	return (
		<div data-testid="graph-context-card" className="my-1">
			<button
				type="button"
				data-testid="graph-context-toggle"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border/70 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
			>
				<ChevronRightIcon aria-hidden="true" className={cn("size-3.5 shrink-0 motion-safe:transition-transform", open && "rotate-90")} />
				<span className="font-medium">Graph context</span>
				<span className="min-w-0 flex-1 truncate">
					{noun(propositions.length, "proposition", "propositions")}
					{chains.length > 0 ? ` · ${noun(chains.length, "chain", "chains")}` : ""}
					{evidence.length > 0 ? ` · ${noun(evidence.length, "source quote", "source quotes")}` : ""}
				</span>
			</button>
			{open && (
				<div data-testid="graph-context-body" className="mt-1 space-y-1 rounded-lg border border-dashed border-border/70 px-4 py-3 text-xs">
					{propositions.map((p) => {
						const e = evidenceFor.get(p.id);
						return (
							<div key={p.id} data-testid={`graph-context-prop-${p.id}`} className="leading-relaxed">
								<span className="font-medium text-foreground/80">{p.name}</span>
								<span className="text-muted-foreground"> — {p.statement}</span>
								{e && (
									<div className="mt-1 mb-2 ml-3 space-y-1">
										<div className="truncate text-[11px] text-muted-foreground">
											{e.source}
											{e.page !== undefined ? `, p. ${e.page}` : ""}
										</div>
										<SourceEvidence quote={e.quote} hunk={e.hunk} />
									</div>
								)}
							</div>
						);
					})}
					{chains.length > 0 && (
						<div className="pt-1">
							{chains.map((c, i) => (
								<div key={i} className="font-mono text-[11px] text-muted-foreground">
									{c}
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
