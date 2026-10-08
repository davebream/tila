import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog } from "radix-ui";
import { type ReactNode, useId, useState } from "react";

interface ConfirmActionProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  /** When set, the user must type this value exactly before confirming. */
  confirmText?: string;
  confirmLabel?: string;
  pending?: boolean;
  error?: ReactNode;
  onConfirm: () => void;
}

/**
 * Confirmation dialog for irreversible destructive actions. This is the only
 * modal in the administration panel; everything else stays inline (DESIGN.md).
 */
export function ConfirmAction({
  open,
  onOpenChange,
  title,
  description,
  confirmText,
  confirmLabel = "Confirm",
  pending = false,
  error,
  onConfirm,
}: ConfirmActionProps) {
  const [typed, setTyped] = useState("");
  const inputId = useId();
  const ready = !confirmText || typed === confirmText;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) setTyped("");
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-background/60 drawer-overlay" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 shadow-drawer outline-hidden"
          aria-describedby={undefined}
        >
          <Dialog.Title className="font-logo text-lg tracking-tight text-foreground">
            {title}
          </Dialog.Title>
          <div className="mt-2 text-sm text-muted-foreground">
            {description}
          </div>
          {confirmText && (
            <div className="mt-4 space-y-1.5">
              <label htmlFor={inputId} className="tila-label block">
                Type{" "}
                <span className="font-mono normal-case">{confirmText}</span> to
                confirm
              </label>
              <Input
                id={inputId}
                value={typed}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                onChange={(e) => setTyped(e.target.value)}
              />
            </div>
          )}
          {error && (
            <p role="alert" className="mt-3 text-sm text-status-red">
              {error}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="ghost" size="sm" disabled={pending}>
                Cancel
              </Button>
            </Dialog.Close>
            <Button
              variant="destructive"
              size="sm"
              disabled={!ready || pending}
              onClick={onConfirm}
            >
              {pending ? "Working…" : confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
