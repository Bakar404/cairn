"use client";

import { useContext, useRef, useState } from "react";
import { ChatActionsContext } from "@/components/chat";
import { DownloadIcon, MaximizeIcon } from "lucide-react";
import { InvertDiscIcon } from "@/components/artifacts/invert-disc";
import { Toggle } from "@/components/settings/controls";
import { useSessionMermaid } from "@/components/session-overlay";
import { downloadFile } from "@/components/artifacts/download";
import { DispatchCard } from "@/components/artifacts/dispatch-card";
import { SvgImage } from "@/components/artifacts/svg-image";
import { mediaUrl, type ArtifactPartProps, type VisualResult } from "@/src/core";

/**
 * Visual artifact card (W6 → ack protocol): the tool part's output is the
 * dispatch ack, so the tool-call box is the DispatchCard (live status via
 * the chat view's jobs feed). The SVG itself renders from the steer message
 * (sub-agent result delivery) via VisualOutputCard, or from the box while
 * the learner holds the delivery.
 *
 * Both display modes use an SVG image document: generated markup and its
 * styles never join the app's DOM. Downloads still contain the original SVG.
 * A Manim still (M13) is a PNG from the chat's media route instead; it
 * keeps the same chrome (invert, download, fullscreen).
 */

/** The svg root's DECLARED width in px, when there is one — the natural
 *  size the card displays at instead of stretching to full width (owner,
 *  2026-10-07). %, em, "auto", or a missing attribute → null (the caller
 *  falls back to full-width). Pure. */
export function svgNaturalWidth(svg: string): number | null {
	const m = /<svg\b[^>]*?\bwidth\s*=\s*["']([^"']+)["'][^>]*>/i.exec(svg);
	if (!m) return null;
	const value = m[1]!.trim();
	const px = /^(\d+(?:\.\d+)?)(?:px)?$/i.exec(value);
	if (!px) return null;
	const n = Number.parseFloat(px[1]!);
	return Number.isFinite(n) && n > 0 ? n : null;
}

export function VisualCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	return (
		<DispatchCard
			toolCallId={part.toolCallId}
			kind="visual"
			renderHeld={(result) => <VisualOutputCard output={result} />}
		/>
	);
}

/** The figure itself — exported: the steer card renders the delivered artifact. */
export function VisualOutputCard({
	output,
	messageId,
	initialInverted = false,
}: {
	output: unknown;
	messageId?: string;
	initialInverted?: boolean;
}) {
	const result = output as VisualResult | undefined;
	const overlay = useSessionMermaid();
	const actions = useContext(ChatActionsContext);
	// Brightness inversion (owner, 2026-10-07): the switch state PERSISTS on
	// the steer record (details.ui.inverted) — seeded here, written through
	// the silent artifact-ui route on toggle; without a chat page (tests,
	// previews) it stays local-only. The toggled state also feeds the
	// fullscreen overlay (openFigure).
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
	// A Manim still (M13) arrives as a PNG in the chat's media folder.
	const png = result?.png && typeof result.png.file === "string" && result.png.file ? result.png : null;
	const natural = !png && result && typeof result.svg === "string" ? svgNaturalWidth(result.svg) : null;
	if (!result || (!png && typeof result.svg !== "string")) {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				Figure completed, but the result could not be displayed.
			</div>
		);
	}
	if (png) return <PngFigure file={png.file} width={png.width} height={png.height} inverted={inverted} onInvert={toggleInverted} />;
	const failed = result.svg.length === 0;
	if (failed) {
		return (
			<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="visual-card-failed">
				<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					Figure
					<span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-500">failed</span>
				</div>
				<p className="mt-2 text-sm text-muted-foreground">{result.notes ?? "The figure could not be drawn."}</p>
			</div>
		);
	}
	return (
		/* NO CARD CHROME (owner round, 2026-10-07): the figure is document
		   material — no border, no padding box. Image first, then the CAPTION
		   ROW below: "Figure" left, the controls right, both edges following
		   the IMAGE's own width (the wrapper carries the natural-sizing law,
		   so the row hugs a centered narrow figure, not the column). */
		<div
			className={
				natural !== null
					? "my-4 mx-auto w-fit max-w-full"
					: "my-4 w-full"
			}
			data-testid="visual-card"
		>
			{/* Natural sizing (owner, 2026-10-07): a declared-width svg sits at
			   ITS size; max-w-full still shrinks oversized ones to fit. No
			   declared size (viewBox-only, %-width) keeps the full-width law.
			   The invert filter rides the bg-white holder, so the backing flips
			   white→black together with the strokes; transparent areas ARE the
			   backing. */}
			<div
				className={
					natural !== null
						? "w-fit max-w-full overflow-hidden rounded-lg bg-white"
						: "w-full overflow-hidden rounded-lg bg-white"
				}
				style={{ filter: inverted ? "invert(1) hue-rotate(180deg)" : undefined }}
				data-testid="visual-svg"
			>
				<SvgImage
					svg={result.svg}
					width={natural ?? undefined}
					className={natural !== null ? "block h-auto max-w-full" : "block h-auto w-full"}
				/>
			</div>
			<div className="mt-2 flex items-center justify-between gap-2">
				<div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Figure</div>
				<div className="flex items-center gap-1.5">
					{/* The invert affordance (owner round, 2026-10-07): the disc IS
					    the half-filled contrast circle; the tooltip names it. */}
					<Toggle
						checked={inverted}
						onChange={toggleInverted}
						label="Invert figure brightness"
						title="Invert colors"
						discIcon={<InvertDiscIcon className="size-3" />}
					/>
					<button
						type="button"
						aria-label="Download figure as SVG"
						title="Download as SVG"
						onClick={() => downloadFile("figure.svg", result.svg, "image/svg+xml")}
						data-testid="visual-download"
						className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<DownloadIcon className="size-3.5" />
					</button>
					{overlay && (
						<button
							type="button"
							aria-label="Open figure fullscreen"
							title="Open fullscreen"
							onClick={() => overlay.openFigure(result.svg, inverted)}
							data-testid="visual-open"
							className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							<MaximizeIcon className="size-3.5" />
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

/** Wrap a PNG data URL in an svg document sized to the still, so the
 *  fullscreen overlay (which draws svg images) can focus a Manim still.
 *  Anything but a base64 PNG data URL → null. Pure. */
export function pngFigureSvg(dataUrl: string, width: number, height: number): string | null {
	if (!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(dataUrl)) return null;
	const w = Math.max(1, Math.round(Number.isFinite(width) ? width : 1));
	const h = Math.max(1, Math.round(Number.isFinite(height) ? height : 1));
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><image href="${dataUrl}" width="${w}" height="${h}"/></svg>`;
}

function blobDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
		reader.onerror = () => reject(reader.error ?? new Error("Could not read the figure."));
		reader.readAsDataURL(blob);
	});
}

/** A Manim still (M13): the PNG plays the SVG's role — same backing, same
 *  invert switch, same caption row. Fullscreen fetches the still from the
 *  app window (so the desktop API capability rides along; a new tab would
 *  open in the system browser without it) and hands the overlay an svg
 *  wrapper. */
function PngFigure({
	file,
	width,
	height,
	inverted,
	onInvert,
}: {
	file: string;
	width?: number;
	height?: number;
	inverted: boolean;
	onInvert: (next: boolean) => void;
}) {
	const actions = useContext(ChatActionsContext);
	const overlay = useSessionMermaid();
	const imgRef = useRef<HTMLImageElement>(null);
	const [opening, setOpening] = useState(false);
	if (!actions?.chatId) {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground" data-testid="visual-png-offline">
				Figure ready. Open the session to view it.
			</div>
		);
	}
	const src = mediaUrl(actions.chatId, file);
	const control = "rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";
	const openFullscreen = async () => {
		if (!overlay || opening) return;
		setOpening(true);
		try {
			const res = await fetch(src);
			if (!res.ok) return;
			const svg = pngFigureSvg(
				await blobDataUrl(await res.blob()),
				imgRef.current?.naturalWidth || width || 1280,
				imgRef.current?.naturalHeight || height || 720,
			);
			if (svg) overlay.openFigure(svg, inverted);
		} catch {
			// The inline still stays usable; fullscreen is a convenience.
		} finally {
			setOpening(false);
		}
	};
	return (
		<div className="my-4 w-full" data-testid="visual-card">
			<div
				className="w-full overflow-hidden rounded-lg bg-white"
				style={{ filter: inverted ? "invert(1) hue-rotate(180deg)" : undefined }}
				data-testid="visual-png"
			>
				{/* A rendered file from the media route; no Next image optimization. */}
				{/* eslint-disable-next-line @next/next/no-img-element */}
				<img ref={imgRef} src={src} alt="Figure" width={width} height={height} className="block h-auto w-full" draggable={false} />
			</div>
			<div className="mt-2 flex items-center justify-between gap-2">
				<div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Figure</div>
				<div className="flex items-center gap-1.5">
					<Toggle
						checked={inverted}
						onChange={onInvert}
						label="Invert figure brightness"
						title="Invert colors"
						discIcon={<InvertDiscIcon className="size-3" />}
					/>
					<a href={src} download="figure.png" aria-label="Download figure as PNG" title="Download as PNG" data-testid="visual-download" className={control}>
						<DownloadIcon className="size-3.5" />
					</a>
					{overlay && (
						<button
							type="button"
							aria-label="Open figure fullscreen"
							title="Open fullscreen"
							disabled={opening}
							onClick={() => void openFullscreen()}
							data-testid="visual-open"
							className={control}
						>
							<MaximizeIcon className="size-3.5" />
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
