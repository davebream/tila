import { Tooltip as TooltipPrimitive } from "radix-ui";
import type * as React from "react";

interface InfoTipProps {
  content: string;
  children: React.ReactNode;
}

export function InfoTip({ content, children }: InfoTipProps) {
  return (
    <TooltipPrimitive.Provider delayDuration={200}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>
          <button
            type="button"
            className="cursor-help underline decoration-dotted underline-offset-2 decoration-muted-foreground/40"
          >
            {children}
          </button>
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side="top"
            sideOffset={4}
            className="z-50 max-w-xs rounded-md bg-foreground px-2.5 py-1.5 text-xs leading-snug text-background shadow-md animate-in fade-in-0 zoom-in-95"
          >
            {content}
            <TooltipPrimitive.Arrow className="fill-foreground" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
