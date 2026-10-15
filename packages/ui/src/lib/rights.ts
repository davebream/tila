import type { Capability, WhoamiResponse, WorkAttempt } from "@tila/schemas";
import {
  permitsRecordRead,
  permitsRecordTypeSide,
  permitsRecordWrite,
  permitsTask,
} from "@tila/schemas";

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
    /** Preview definition changes (participant threshold, `schema:preview`). */
    previewDefinitions: write && has("schema:preview"),
    /** Apply definitions (maintainer threshold, `schema:write`); not owner-only. */
    applyDefinitions: manage && has("schema:write"),
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
    /**
     * Whether the credential may write a record. Without a key: whether some
     * key of `type` may be written, which is what a create or a type-level
     * control means. Uses the write side only, so a credential that cannot
     * read a record may still be offered a write to it.
     */
    writeRecord: (type: string, key?: string) =>
      write &&
      has("records:write") &&
      (key === undefined
        ? permitsRecordTypeSide(restrictions, "write", type)
        : permitsRecordWrite(restrictions, type, key)),
    /**
     * Whether the credential may read a record, on the read side only. Without
     * a key: whether some key of `type` may be read. A credential that may
     * write a key but not read it must not be offered a way to open it.
     */
    readRecord: (type: string, key?: string) =>
      has("records:read") &&
      (key === undefined
        ? permitsRecordTypeSide(restrictions, "read", type)
        : permitsRecordRead(restrictions, type, key)),
    /** Any write the questions API may accept from this credential. */
    decide: taskWrite,
    /** Register, edit and archive agents (maintainer, `agents:manage`). */
    manageAgents: manage && has("agents:manage"),
    /** Create rooms, edit their policy and members (`conversations:manage`). */
    manageRooms: manage && has("conversations:manage"),
    /** Create, edit and delete signal groups (`signals:manage`). */
    manageSignalGroups: manage && has("signals:manage"),
  };
}

export type Rights = ReturnType<typeof rights>;

/**
 * Whether the server's attempt-control rule (#392) lets this caller request
 * cancellation, suspension, resume or retry: the attempt's current owner
 * (principal and this browser's participant), the principal that enrolled the
 * work, or a maintainer. Unknown inputs defer to the server's answer.
 */
export function controlsAttempt(
  identity: WhoamiResponse | undefined,
  allowed: Rights,
  attempt: Pick<WorkAttempt, "principal_id" | "participant_id">,
  assigner: string | null | undefined,
  participant: string,
): boolean {
  if (!allowed.operate) return false;
  if (identity?.principal_id === undefined || assigner === undefined)
    return true;
  if (allowed.reconcile) return true;
  if (
    identity.principal_id === attempt.principal_id &&
    participant === attempt.participant_id
  )
    return true;
  return assigner !== null && assigner === identity.principal_id;
}

/** Queue `edit`/`withdraw`: the assigner or a maintainer (legacy entries: any task writer). */
export function editsEnrollment(
  identity: WhoamiResponse | undefined,
  allowed: Rights,
  assigner: string | null,
): boolean {
  if (!allowed.edit) return false;
  if (allowed.manage || assigner === null) return true;
  return identity?.principal_id === assigner;
}
