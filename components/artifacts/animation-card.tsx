"use client";

import { useContext, useState } from "react";
import { DownloadIcon } from "lucide-react";
import { ChatActionsContext } from "@/components/chat";
import { InvertDiscIcon } from "@/components/artifacts/invert-disc";
import { Toggle } from "@/components/settings/controls";
import { DispatchCard } from "@/components/artifacts/dispatch-card";
import { slugFilename } from "@/components/artifacts/download";
import { mediaUrl, type AnimationResult, type ArtifactPartProps } from "@/src/core";

/**
 * Animation artifact card (M13): the tool part's output is the dispatch
 * ack, so the tool-call box is the DispatchCard; the MP4 itself plays from
 * the steer message via AnimationOutputCard (or from the box while the
 * learner holds the delivery). The file is served by the chat's media
 * route, never inlined into the record.
 */
export function AnimationCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	return (
		<DispatchCard
			toolCallId={part.toolCallId}
			kind="animation"
			renderHeld={(result) => <AnimationOutputCard output={result} />}
		/>
	);
}

/** The video itself — exported: the steer card renders the delivered artifact. */
export function AnimationOutputCard({
	output,
	messageId,
	initialInverted = false,
}: {
	output: unknown;
	messageId?: string;
	initialInverted?: boolean;
}) {
	const result = output as AnimationResult | undefined;
	const actions = useContext(ChatActionsContext);
	// Same persisted invert switch as the figure card (details.ui.inverted).
	const [inverted, setInverted] = useState(initialInverted);
	const toggleInverted = (next: boolean) => {
		setInverted(next);
		if (!actions?.chatId || !messageId) return;
		void fetch(`/api/chats/${actions.chatId}/artifact-ui`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { messageId, inverted: next } }),
		}).catch(() => {});
	};
	if (!result || typeof result !== "object") {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				Animation completed, but the result could not be displayed.
			</div>
		);
	}
	const video = result.video && typeof result.video.file === "string" && result.video.file ? result.video : null;
	if (!video) {
		return (
			<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="animation-card-failed">
				<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					Animation
					<span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-500">failed</span>
				</div>
				<p className="mt-2 text-sm text-muted-foreground">{result.notes ?? "The animation could not be made."}</p>
			</div>
		);
	}
	if (!actions?.chatId) {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground" data-testid="animation-card-offline">
				Animation ready: {result.title}. Open the session to play it.
			</div>
		);
	}
	const src = mediaUrl(actions.chatId, video.file);
	const poster = result.poster?.file ? mediaUrl(actions.chatId, result.poster.file) : undefined;
	const duration =
		typeof result.durationSec === "number" && Number.isFinite(result.durationSec)
			? `${Math.max(1, Math.round(result.durationSec))} s`
			: null;
	return (
		<div className="my-4 w-full" data-testid="animation-card">
			{/* The invert filter rides the white holder, as on the figure card:
			    Manim scenes render on white, so dark mode can flip them. */}
			<div
				className="w-full overflow-hidden rounded-lg bg-white"
				style={{ filter: inverted ? "invert(1) hue-rotate(180deg)" : undefined }}
			>
				<video
					controls
					playsInline
					preload="metadata"
					src={src}
					poster={poster}
					width={video.width}
					height={video.height}
					aria-label={result.title}
					className="block h-auto w-full"
					data-testid="animation-video"
				/>
			</div>
			<div className="mt-2 flex items-center justify-between gap-2">
				<div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
					<span className="font-medium uppercase tracking-wide">Animation</span>
					<span className="truncate">{result.title}</span>
					{duration && <span className="shrink-0">· {duration}</span>}
				</div>
				<div className="flex items-center gap-1.5">
					<Toggle
						checked={inverted}
						onChange={toggleInverted}
						label="Invert animation brightness"
						title="Invert colors"
						discIcon={<InvertDiscIcon className="size-3" />}
					/>
					<a
						href={src}
						download={`${result.title ? slugFilename(result.title) : "animation"}.mp4`}
						aria-label="Download animation as MP4"
						title="Download as MP4"
						data-testid="animation-download"
						className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<DownloadIcon className="size-3.5" />
					</a>
				</div>
			</div>
		</div>
	);
}
