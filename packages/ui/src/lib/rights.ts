import type { Capability, WhoamiResponse } from "@tila/schemas";
import { permitsRecord, permitsTask } from "@tila/schemas";

/**
 * What the current credential may attempt in this project. These only decide
 * which controls are offered; the server enforces every write again, so a
 * stale answer produces a visible 403, never a silent bypass.
 *
 * A credential without an explicit policy keeps its role's compatibility
 * capabilities, so only role and namespace restrictions narrow it.
 */
export function rights(identity: WhoamiResponse | undefined, project: string) {
  const role = identity?.project_id === project ? identity.role : undefined;
  const write = !!role && role !== "viewer" && identity?.permission !== "read";
  const manage = write && (role === "maintainer" || role === "owner");
  const restrictions = identity?.policy?.restrictions;
  const has = (...caps: Capability[]) =>
    !identity?.policy ||
    caps.every((cap) =>
      (identity.policy?.capabilities as string[]).includes(cap),
    );
  const taskWrite = write && has("tasks:write");
  return {
    principal: identity?.principal_id ?? null,
    role: role ?? null,
    owner: role === "owner",
    manage,
    edit: taskWrite,
    operate: write && has("tasks:write", "claims:renew"),
    configure: manage && has("schema:write"),
    reconcile: manage && has("tasks:write", "claims:renew"),
    force: manage && has("tasks:write", "claims:acquire", "schema:write"),
    /** Create a task of `type` (create never needs a claim). */
    createTask: (type: string) => taskWrite && permitsTask(restrictions, type),
    /** Edit an unmanaged task: a claim supplies the fence. */
    editTask: (type: string) =>
      taskWrite && has("claims:acquire") && permitsTask(restrictions, type),
    /** Content-only edits of queue-managed work need no claim. */
    editManagedTask: (type: string) =>
      taskWrite && permitsTask(restrictions, type),
    instantiate: (types: string[]) =>
      taskWrite &&
      has("templates:instantiate") &&
      types.every((type) => permitsTask(restrictions, type)),
    linkTasks: taskWrite,
    /** Without a key: whether any key of `type` may be written. */
    writeRecord: (type: string, key?: string) =>
      write &&
      has("records:write") &&
      (key === undefined
        ? restrictions?.records === undefined ||
          restrictions.records.some((rule) => rule.type === type)
        : permitsRecord(restrictions, type, key)),
    /** Any write the questions API may accept from this credential. */
    decide: taskWrite,
  };
}

export type Rights = ReturnType<typeof rights>;
