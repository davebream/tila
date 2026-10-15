import type { QueueBlockReason } from "@tila/schemas";
import { Link } from "react-router";

type Code = QueueBlockReason["code"];

/** Codes whose `resource` names a predecessor task, not the entry's own work. */
const DEPENDENCY_CODES: ReadonlySet<Code> = new Set([
  "dependency-missing",
  "dependency-unsatisfied",
  "dependency-lifecycle-unconfigured",
  "dependency-cycle",
]);

export type Blocker =
  /** The server withheld the predecessor: nothing about it may be shown. */
  | { kind: "restricted" }
  /** `resource` is a pending gate's ID, not a task. */
  | { kind: "gate"; code: Code; gate: string }
  /** A predecessor the server returned as visible. */
  | {
      kind: "dependency";
      code: Code;
      task: string;
      /** A missing predecessor has no task page to open. */
      linkable: boolean;
      state?: string;
      path: string[];
    }
  /** The entry's own readiness or queue condition (`state` is its own). */
  | { kind: "own"; code: Code; state?: string };

/**
 * Reads one block reason exactly as the server sent it. It never looks up
 * tasks or relationships: a predecessor is shown only if the payload names it.
 *
 * `inspect` in ops-sqlite replaces a dependency reason that touches a task the
 * caller may not read with `{ code, resource: <the entry's own task> }`, with
 * no `state` or `path`. A genuine dependency reason never names the entry's own
 * task without a cycle `path`, so that shape is a restricted predecessor, not a
 * task blocking itself.
 */
export function describeBlockReason(
  reason: QueueBlockReason,
  taskId: string,
): Blocker {
  if (reason.code === "gate-pending")
    return { kind: "gate", code: reason.code, gate: reason.resource };
  if (!DEPENDENCY_CODES.has(reason.code))
    return { kind: "own", code: reason.code, state: reason.state };
  if (reason.resource === taskId && !reason.path?.length)
    return { kind: "restricted" };
  return {
    kind: "dependency",
    code: reason.code,
    task: reason.resource,
    linkable: reason.code !== "dependency-missing",
    state: reason.state,
    path: reason.path ?? [],
  };
}

const Dot = () => <span aria-hidden="true">·</span>;

function BlockerLine({
  project,
  blocker,
}: {
  project: string;
  blocker: Blocker;
}) {
  if (blocker.kind === "restricted")
    return <span>Waiting on a restricted predecessor</span>;
  if (blocker.kind === "gate")
    return (
      <>
        <span>{blocker.code}</span>{" "}
        <span className="font-mono break-all">{blocker.gate}</span>
      </>
    );
  if (blocker.kind === "own")
    return (
      <>
        <span>{blocker.code}</span>
        {blocker.state && (
          <>
            {" "}
            <Dot /> <span>{blocker.state}</span>
          </>
        )}
      </>
    );
  return (
    <>
      <span>{blocker.code}</span>{" "}
      {blocker.linkable ? (
        <Link
          className="font-mono break-all text-signal-blue"
          to={`/p/${project}/tasks/${encodeURIComponent(blocker.task)}`}
        >
          {blocker.task}
        </Link>
      ) : (
        <span className="font-mono break-all">{blocker.task}</span>
      )}
      {blocker.state && (
        <>
          {" "}
          <Dot /> <span>{blocker.state}</span>
        </>
      )}
      {blocker.path.length > 0 && (
        <>
          {" "}
          <Dot /> <span>{blocker.path.join(" → ")}</span>
        </>
      )}
    </>
  );
}

/** The block reasons for one queue entry, from the queue payload alone. */
export function BlockReasons({
  project,
  taskId,
  reasons,
}: {
  project: string;
  taskId: string;
  reasons: QueueBlockReason[];
}) {
  if (!reasons.length) return null;
  return (
    <ul
      aria-label={`Blockers for ${taskId}`}
      className="mt-1 space-y-0.5 text-xs text-status-amber"
    >
      {reasons.map((reason, index) => (
        <li key={`${reason.code}:${index}`}>
          <BlockerLine
            project={project}
            blocker={describeBlockReason(reason, taskId)}
          />
        </li>
      ))}
    </ul>
  );
}
