import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import type { ErrorKind, SectionState, StaleInfo } from "@/lib/query-state";
import { formatTime } from "@/lib/time";
import { type ReactNode, useRef } from "react";

const capitalize = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1);

function Muted({ children }: { children: ReactNode }) {
  return <p className="py-3 text-sm text-muted-foreground">{children}</p>;
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      onClick={onRetry}
      className="font-mono text-muted-foreground"
    >
      Retry
    </Button>
  );
}

/** Amber, persistent notice for data that is shown but not current. */
export function SectionNotice({
  children,
  onRetry,
}: {
  children: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <output className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-tint-amber px-3 py-2 text-xs text-status-amber">
      <span>{children}</span>
      {onRetry && <RetryButton onRetry={onRetry} />}
    </output>
  );
}

/** Why a refresh failed, in words that do not change between failed polls. */
function staleReason({ kind, error }: StaleInfo): string {
  if (
    error instanceof TypeError ||
    (error instanceof ApiError && error.code === "network-error")
  ) {
    return "cannot reach server";
  }
  if (kind === "unavailable") return "server unavailable";
  return error instanceof Error ? error.message : "request failed";
}

/** "Showing {label} from HH:MM:SS. Refresh failed: …" for last-good data. */
export function StaleNotice({
  label,
  updatedAt,
  stale,
  onRetry,
}: {
  label: string;
  updatedAt: number;
  stale: StaleInfo;
  onRetry?: () => void;
}) {
  return (
    <SectionNotice onRetry={onRetry}>
      Showing {label} from{" "}
      <time dateTime={new Date(updatedAt).toISOString()} className="font-mono">
        {formatTime(updatedAt)}
      </time>
      . Refresh failed: {staleReason(stale)}.
    </SectionNotice>
  );
}

/** Failure with no usable data. Forbidden and not-found are not retryable. */
export function SectionFailure({
  kind,
  error,
  label,
  onRetry,
  forbidden,
  notFound,
}: {
  kind: ErrorKind;
  error: unknown;
  label: string;
  onRetry?: () => void;
  forbidden?: string;
  notFound?: string;
}) {
  if (kind === "forbidden") {
    return <Muted>{forbidden ?? `You do not have access to ${label}.`}</Muted>;
  }
  if (kind === "not-found") {
    return <Muted>{notFound ?? `${capitalize(label)} not found.`}</Muted>;
  }
  if (kind === "unauthenticated") {
    return (
      <div role="alert" className="space-y-1 py-3">
        <p className="text-sm text-status-red">Session expired.</p>
        <p className="text-xs text-muted-foreground">
          Sign in again to load {label}.
        </p>
      </div>
    );
  }
  const code = error instanceof ApiError ? error.code : null;
  return (
    <div role="alert" className="space-y-1 py-3">
      <p className="text-sm text-status-red">Could not load {label}.</p>
      <p className="text-xs text-muted-foreground">
        Its current state is unknown.
      </p>
      {code && (
        <p className="font-mono text-[11px] text-muted-foreground">{code}</p>
      )}
      {onRetry && <RetryButton onRetry={onRetry} />}
    </div>
  );
}

/**
 * One independently fetched section. Renders loading, failure, true absence and
 * stale-with-last-success distinctly, so a pending or failed request is never
 * shown as "nothing here".
 *
 * `children` renders only when there is something to show. `empty` is the
 * affirmative-absence text; it is shown on a fresh success only, and as
 * "Last known: …" beside the stale notice when the latest refresh failed.
 * The slot order is fixed (`notice`, then content) so children keep their state
 * when a section flips between ready and stale.
 */
export function QuerySection<T>({
  state,
  label,
  empty,
  onRetry,
  forbidden,
  notFound,
  children,
}: {
  state: SectionState<T>;
  /** Lowercase noun phrase used in messages, e.g. "claim state". */
  label: string;
  empty: string;
  onRetry?: () => void;
  forbidden?: string;
  notFound?: string;
  children: (data: T, ctx: { stale: StaleInfo | null }) => ReactNode;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  // Retry removes the failure UI on success; park focus on the wrapper first so
  // it is not dropped to <body> (and out of an open dialog).
  const retry = onRetry
    ? () => {
        wrapper.current?.focus({ preventScroll: true });
        onRetry();
      }
    : undefined;

  let body: ReactNode;
  if (state.phase === "pending") {
    body = (
      <output className="block py-3 text-sm text-muted-foreground">
        {state.paused
          ? `Waiting for network to load ${label}…`
          : `Loading ${label}…`}
      </output>
    );
  } else if (state.phase === "failed") {
    body = (
      <SectionFailure
        kind={state.kind}
        error={state.error}
        label={label}
        onRetry={retry}
        forbidden={forbidden}
        notFound={notFound}
      />
    );
  } else {
    const { stale } = state;
    body = (
      <>
        {stale ? (
          <StaleNotice
            label={label}
            updatedAt={state.updatedAt}
            stale={stale}
            onRetry={retry}
          />
        ) : null}
        {state.empty ? (
          <Muted>{stale ? `Last known: ${empty}` : empty}</Muted>
        ) : (
          children(state.data, { stale })
        )}
      </>
    );
  }

  return (
    <div
      ref={wrapper}
      tabIndex={-1}
      aria-busy={state.phase === "pending"}
      className="space-y-3 outline-none"
    >
      {body}
    </div>
  );
}
