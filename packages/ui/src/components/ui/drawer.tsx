import { X } from "lucide-react";
import { Dialog } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

interface DrawerProps {
  children: React.ReactNode;
  onClose: () => void;
  title: React.ReactNode;
  expanded?: boolean;
  headerActions?: React.ReactNode;
}

export function Drawer({
  children,
  onClose,
  title,
  expanded,
  headerActions,
}: DrawerProps) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-background/60 drawer-overlay" />
        <Dialog.Content
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex flex-col border-l border-border bg-card shadow-drawer outline-hidden drawer-panel",
            expanded ? "w-full" : "w-full max-w-2xl",
          )}
          aria-describedby={undefined}
        >
          <div className="flex shrink-0 items-center justify-between border-b border-border px-6 py-4">
            <Dialog.Title className="min-w-0 truncate font-logo text-xl tracking-tight text-foreground">
              {title}
            </Dialog.Title>
            <div className="flex shrink-0 items-center gap-1">
              {headerActions}
              <button
                type="button"
                onClick={onClose}
                className="cursor-pointer rounded-sm p-1.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-blue"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
