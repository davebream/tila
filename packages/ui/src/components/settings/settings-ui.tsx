import { Button } from "@/components/ui/button";
import { FormNotice } from "@/components/ui/form-fields";
import { splitLines } from "@/lib/definition-values";
import {
  failureKind,
  failureMessage,
  revisionConflict,
} from "@/lib/mutation-errors";
import type { ReactNode } from "react";

/** Page heading for a settings tab, with optional actions on the right. */
export function SettingsHeading({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start gap-3">
      <div className="min-w-0 flex-1 space-y-1">
        <h1 className="font-logo text-xl tracking-tight text-foreground">
          {title}
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{children}</p>
      </div>
      {actions}
    </header>
  );
}

/** The muted sentence shown in place of controls the viewer cannot use. */
export function ManageNote({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

/** Read-only facts as a two-column definition list. */
export function Facts({
  label,
  rows,
}: {
  label: string;
  rows: Array<[string, ReactNode]>;
}) {
  return (
    <dl
      aria-label={label}
      className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm"
    >
      {rows.map(([term, detail]) => (
        <div key={term} className="contents">
          <dt className="text-xs text-muted-foreground">{term}</dt>
          <dd className="min-w-0 break-words font-mono text-xs">{detail}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Non-empty trimmed lines, first occurrence kept. */
export function uniqueLines(text: string): string[] {
  return [...new Set(splitLines(text))];
}

/** "a", "a and b", "a, b and c". */
export function joinWords(words: readonly string[]): string {
  if (words.length < 2) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * A failed write, worded by what the user can do next. Revision conflicts are
 * shown by `LandedNotice` instead.
 */
export function WriteFailure({
  error,
  action,
}: {
  error: unknown;
  /** "save", "archive", ... */
  action: string;
}) {
  if (!error || revisionConflict(error)) return null;
  const kind = failureKind(error);
  if (kind === "unconfirmed")
    return (
      <FormNotice tone="warning">
        The server did not confirm this {action} ({failureMessage(error)}).
        Retry sends the same request, so it is applied at most once.
      </FormNotice>
    );
  if (kind === "forbidden")
    return (
      <FormNotice>
        Your access changed and nothing was saved: {failureMessage(error)}
      </FormNotice>
    );
  return <FormNotice>{failureMessage(error)}</FormNotice>;
}

/**
 * Another change landed on the resource a drawer edits. Nothing was saved and
 * the edits stay; the user chooses to keep them on the new revision (fields
 * they did not touch take the new values) or to load the latest values.
 */
export function LandedNotice({
  revision,
  changed,
  onKeepMine,
  onLoadLatest,
}: {
  /** The current revision; null while it is being loaded. */
  revision: number | null;
  /** Labels of the fields in this form that the other change touched. */
  changed: readonly string[];
  onKeepMine?: () => void;
  onLoadLatest?: () => void;
}) {
  return (
    <FormNotice tone="warning">
      <span className="block">
        Another change landed
        {revision === null ? "" : ` (revision ${revision})`}.{" "}
        {revision === null || !onKeepMine
          ? "Loading it…"
          : changed.length
            ? `It changed ${joinWords(changed)}.`
            : "It did not change the settings in this form."}{" "}
        Nothing was saved and your edits are kept.
      </span>
      {revision !== null && onKeepMine && onLoadLatest && (
        <span className="mt-2 flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onKeepMine}
          >
            Keep my edits on revision {revision}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onLoadLatest}
          >
            Load latest
          </Button>
        </span>
      )}
    </FormNotice>
  );
}
