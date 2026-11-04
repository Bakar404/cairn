import type { SourceHunk } from "@/src/core";
import { cn } from "@/lib/utils";

/** A checked quote from an imported source (M25), with the diff hunk it
 *  sits in for a code change (M22). Shown under a file source in the graph
 *  detail card and under a pick in a session's graph-context card. The
 *  +/- prefixes stay visible, so line color is never the only signal. */
export function SourceEvidence({ quote, hunk, className }: { quote: string; hunk?: SourceHunk; className?: string }) {
	return (
		<div className={cn("flex flex-col gap-1.5", className)} data-testid="source-evidence">
			<blockquote className="border-l-2 pl-2 text-xs italic leading-relaxed text-muted-foreground">
				&ldquo;{quote}&rdquo;
			</blockquote>
			{hunk && (
				<figure className="overflow-hidden rounded-md border">
					<figcaption className="truncate border-b bg-muted/50 px-2 py-1 font-mono text-[11px] text-muted-foreground">
						{hunk.file}
					</figcaption>
					<pre className="max-h-40 overflow-auto px-2 py-1 font-mono text-[11px] leading-snug">
						<span className="text-muted-foreground">{hunk.header}</span>
						{"\n"}
						{hunk.text.split("\n").map((line, i) => (
							<span
								key={i}
								className={
									line.startsWith("+")
										? "block text-emerald-700 dark:text-emerald-400"
										: line.startsWith("-")
											? "block text-rose-700 dark:text-rose-400"
											: "block text-muted-foreground"
								}
							>
								{line || " "}
							</span>
						))}
					</pre>
				</figure>
			)}
		</div>
	);
}
