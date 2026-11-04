"use client"

import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { keyboardModality } from "@/components/input-modality"
import { cn } from "@/lib/utils"

/**
 * The styled tooltip (tooltip wave → subtlety round, owner 2026-09-25):
 * a quiet dark chip, not a white slab — accent tone (the hover-chip color),
 * 11px, minimal padding, no arrow (nothing purely decorative). Opens after
 * a 500ms rest, so tooltips appear when you pause on a control, never in
 * passing; disableHoverableContent means the chip is un-hoverable — the
 * instant the cursor leaves the trigger it's gone, even mid-move onto the
 * chip's own pixels.
 */

/** The hover rest delay (ms). Keyboard focus opens at once (Radix). */
export const TOOLTIP_DELAY_MS = 500

function TooltipProvider({
  delayDuration = TOOLTIP_DELAY_MS,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  disableHoverableContent = true,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return (
    <TooltipPrimitive.Root
      data-slot="tooltip"
      disableHoverableContent={disableHoverableContent}
      {...props}
    />
  )
}

function TooltipTrigger({
  onFocus,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      // Focus opens the tooltip only when it came from the keyboard (M27):
      // focus a pointer user didn't ask for (the window coming back to the
      // front, a script) must not pop a tooltip. A dialog or menu handing
      // focus back never gets here: it focuses from a layout cleanup, and
      // React ignores DOM events during a commit. Radix skips its open when
      // the event is default-prevented.
      onFocus={(e) => {
        onFocus?.(e)
        if (!keyboardModality()) e.preventDefault()
      }}
      {...props}
    />
  )
}

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-fit origin-(--radix-tooltip-content-transform-origin) animate-in rounded-md bg-accent px-2 py-1 text-[11px] text-foreground/85 text-balance fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }