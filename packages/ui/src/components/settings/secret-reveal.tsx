import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { type ReactNode, useEffect, useRef } from "react";

/**
 * One-time display of a newly created secret (a credential or an invitation).
 * The secret lives only in the owning page's React state: it is never written
 * to session storage, an operation draft or the query cache, and it is gone
 * once this panel is dismissed or the page unmounts.
 */
export function SecretReveal({
  title,
  secret,
  children,
  onDismiss,
}: {
  title: string;
  secret: string;
  children?: ReactNode;
  onDismiss: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <section
      aria-labelledby="secret-reveal-title"
      className="space-y-3 rounded-lg border border-status-amber/40 bg-tint-amber p-4"
    >
      <h2
        id="secret-reveal-title"
        ref={heading}
        tabIndex={-1}
        className="font-logo text-lg tracking-tight text-foreground outline-none"
      >
        {title}
      </h2>
      <p className="text-sm text-foreground">
        This is the only time the secret is shown. Copy it now and store it
        where its client reads it; it cannot be shown again.
      </p>
      <div className="flex items-start gap-2">
        <code
          aria-label="Secret"
          className="min-w-0 flex-1 break-all rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-fg-strong"
        >
          {secret}
        </code>
        <CopyButton value={secret} />
      </div>
      {children && (
        <div className="space-y-1 text-xs text-muted-foreground">
          {children}
        </div>
      )}
      <Button type="button" size="sm" onClick={onDismiss}>
        I stored it, hide the secret
      </Button>
    </section>
  );
}
