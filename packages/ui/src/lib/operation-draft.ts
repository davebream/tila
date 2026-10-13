import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

/**
 * A form draft plus the exact command submitted from it. Staging freezes the
 * command (and so its idempotency key); a retry after a lost response resends
 * that same command, so the server's receipt answers instead of applying it
 * twice. Editing after staging starts a new revision, but the frozen command
 * stays until the server answers or the user reviews a conflict.
 *
 * Generalizes the conversation reply draft (`conversation-draft.ts`) to any
 * mutation: task create/edit, record writes, decisions and follow-ups.
 */
export interface OperationDraft<V, C> {
  revision: string;
  value: V;
  pending: { revision: string; id: string; command: C } | null;
}

export function newOperation<V, C>(value: V): OperationDraft<V, C> {
  return { revision: crypto.randomUUID(), value, pending: null };
}

export function editOperation<V, C>(
  draft: OperationDraft<V, C>,
  value: V,
): OperationDraft<V, C> {
  return { ...draft, revision: crypto.randomUUID(), value };
}

/**
 * Freeze the command for the current value unless one is already pending.
 * `id` is the operation's stable identity; use it as the idempotency key.
 */
export function stageOperation<V, C>(
  draft: OperationDraft<V, C>,
  build: (value: V, id: string) => C,
): OperationDraft<V, C> {
  if (draft.pending) return draft;
  const id = crypto.randomUUID();
  return {
    ...draft,
    pending: { revision: draft.revision, id, command: build(draft.value, id) },
  };
}

/**
 * The server answered operation `id`. Clear the draft when nothing was edited
 * since staging; otherwise keep the newer input and drop only the pending op.
 */
export function completeOperation<V, C>(
  draft: OperationDraft<V, C>,
  id: string,
  reset: () => OperationDraft<V, C>,
): OperationDraft<V, C> {
  if (draft.pending?.id !== id) return draft;
  return draft.revision === draft.pending.revision
    ? reset()
    : { ...draft, pending: null };
}

/** A conflict or rejection: keep the input, forget the frozen command. */
export function releaseOperation<V, C>(
  draft: OperationDraft<V, C>,
): OperationDraft<V, C> {
  return draft.pending ? { ...draft, pending: null } : draft;
}

export function operationKey(kind: string, ...scope: Array<string | null>) {
  return `tila.${kind}.1:${JSON.stringify(scope)}`;
}

function load<V, C>(
  key: string,
  value: z.ZodType<V>,
  command: z.ZodType<C>,
): OperationDraft<V, C> | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = z
      .object({
        revision: z.string(),
        value,
        pending: z
          .object({ revision: z.string(), id: z.string(), command })
          .nullable(),
      })
      .safeParse(JSON.parse(raw));
    return parsed.success ? (parsed.data as OperationDraft<V, C>) : null;
  } catch {
    return null; // Unavailable or corrupt browser storage.
  }
}

function save(key: string, draft: OperationDraft<unknown, unknown> | null) {
  try {
    if (draft) window.sessionStorage.setItem(key, JSON.stringify(draft));
    else window.sessionStorage.removeItem(key);
  } catch {
    /* Storage unavailable: the draft still lives for this page. */
  }
}

/**
 * Session-scoped draft state. The key should include the principal and the
 * subject so another account or another task never inherits the input.
 * `discard` removes it (closing a form on purpose); unmounting keeps it.
 */
export function useOperationDraft<V, C>(
  key: string | null,
  initial: () => V,
  schemas: { value: z.ZodType<V>; command: z.ZodType<C> },
) {
  // The latest `initial` builds fresh drafts; callers pass inline closures.
  const initialRef = useRef(initial);
  initialRef.current = initial;
  const fresh = useCallback(() => newOperation<V, C>(initialRef.current()), []);
  const [state, setState] = useState<{
    key: string | null;
    draft: OperationDraft<V, C>;
  }>(() => ({
    key,
    draft: (key && load(key, schemas.value, schemas.command)) || fresh(),
  }));
  let draft = state.draft;
  if (state.key !== key) {
    draft = (key && load(key, schemas.value, schemas.command)) || fresh();
    setState({ key, draft });
  }
  useEffect(() => {
    if (key && state.key === key) save(key, state.draft);
  }, [key, state]);
  const update = useCallback(
    (next: (draft: OperationDraft<V, C>) => OperationDraft<V, C>) =>
      setState((current) => ({ ...current, draft: next(current.draft) })),
    [],
  );
  const discard = useCallback(() => {
    if (key) save(key, null);
    setState({ key, draft: fresh() });
  }, [key, fresh]);
  return { draft, update, discard, fresh };
}
