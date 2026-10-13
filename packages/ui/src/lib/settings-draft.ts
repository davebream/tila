import { useCallback, useEffect, useMemo } from "react";
import { z } from "zod";
import {
  completeOperation,
  editOperation,
  releaseOperation,
  stageOperation,
  useOperationDraft,
} from "./operation-draft";

/**
 * A drawer's copy of one revisioned settings resource (an agent, a room, a
 * signal group): the values it was opened on (`base`, at `revision`) and the
 * user's edits (`form`). Saves name `revision`, so a change that landed in
 * between is reported as a conflict instead of being overwritten.
 */
export type SettingsCopy<F> = { revision: number; base: F; form: F };

const json = (value: unknown) => JSON.stringify(value);

/**
 * Session-scoped settings draft built on `useOperationDraft`: staging freezes
 * the command and its idempotency key, so a retry after a lost response
 * resends the same request; a conflict releases it, so the next save gets a
 * new key.
 *
 * An untouched copy follows the current resource. An edited one stays on its
 * revision until the user saves, loads the latest values or keeps their edits
 * on top of the latest revision (`keepMine`).
 */
export function useSettingsDraft<F extends Record<string, unknown>, C>({
  key,
  current,
  canonical,
  schemas,
}: {
  /** Storage key; null keeps the copy for this page only. */
  key: string | null;
  current: { revision: number; form: F };
  /** Comparable value of each field (trimmed text, parsed lists, numbers). */
  canonical: (form: F) => Record<keyof F, unknown>;
  schemas: { form: z.ZodType<F>; command: z.ZodType<C> };
}) {
  const value = useMemo(
    () =>
      z.object({
        revision: z.number(),
        base: schemas.form,
        form: schemas.form,
      }) as unknown as z.ZodType<SettingsCopy<F>>,
    [schemas.form],
  );
  const { draft, update, discard, fresh } = useOperationDraft<
    SettingsCopy<F>,
    C
  >(
    key,
    () => ({
      revision: current.revision,
      base: current.form,
      form: current.form,
    }),
    { value, command: schemas.command },
  );
  const copy = draft.value;
  const fields = Object.keys(current.form) as Array<keyof F>;
  const differs = (a: F, b: F) => {
    const left = canonical(a);
    const right = canonical(b);
    return fields.filter((field) => json(left[field]) !== json(right[field]));
  };
  /** Fields the user changed. */
  const edited = differs(copy.base, copy.form);
  const dirty = edited.length > 0;
  // Revisions come from one project-wide counter, so a higher one is newer.
  // A lower current one is a list that has not caught up with our own write.
  const newer = current.revision > copy.revision;
  /** Fields that changed between the copy's revision and the current one. */
  const landed = newer ? differs(copy.base, current.form) : [];

  const follow = !dirty && !draft.pending && newer;
  useEffect(() => {
    if (follow) discard();
  }, [follow, discard]);

  const edit = useCallback(
    (change: (form: F) => F) =>
      update((d) =>
        editOperation(d, { ...d.value, form: change(d.value.form) }),
      ),
    [update],
  );

  /** Freeze the command for the current copy; returns the pending operation. */
  function stage(build: (copy: SettingsCopy<F>) => C) {
    const next = stageOperation(draft, (v) => build(v));
    update(() => next);
    return next.pending;
  }

  /**
   * Move the copy onto the current revision, keeping each field the user
   * edited and taking every other field from the current values, so nothing
   * someone else changed is reverted by accident.
   */
  function keepMine() {
    update((d) => {
      const mine = differs(d.value.base, d.value.form);
      const form = { ...current.form };
      for (const field of mine) form[field] = d.value.form[field];
      return editOperation(releaseOperation(d), {
        revision: current.revision,
        base: current.form,
        form,
      });
    });
  }

  /** Our own write moved the resource from `from` to `to` (room members). */
  const advance = useCallback(
    (from: number, to: number) =>
      update((d) =>
        d.value.revision === from
          ? { ...d, value: { ...d.value, revision: to } }
          : d,
      ),
    [update],
  );

  return {
    form: copy.form,
    base: copy.base,
    revision: copy.revision,
    edited,
    dirty,
    /** Edited, and another change has landed since the copy was opened. */
    stale: dirty && newer,
    landed,
    pending: draft.pending,
    edit,
    stage,
    keepMine,
    advance,
    release: () => update(releaseOperation),
    complete: (id: string) => update((d) => completeOperation(d, id, fresh)),
    /** Drop the edits; the copy reopens on the current values. */
    discard,
  };
}
