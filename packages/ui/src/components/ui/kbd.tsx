import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

interface KbdProps {
  children: ReactNode;
  className?: string;
}

export function Kbd({ children, className }: KbdProps) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center font-mono text-[11px] leading-none px-[5px] pt-[3px] pb-[2px] rounded-[4px] bg-background border border-border border-b-2 text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
