import type { ReadinessContext } from "@/lib/readiness-context";
import { Link } from "react-router";

const LINK =
  "rounded-sm text-signal-blue underline decoration-signal-blue/40 underline-offset-2 hover:text-signal-blue-hover hover:decoration-signal-blue focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-blue";

/** Long lists are cut so one project with many legacy types stays readable. */
const MAX_NAMED = 5;

function Types({ names }: { names: string[] }) {
  const shown = names.slice(0, MAX_NAMED);
  const rest = names.length - shown.length;
  return (
    <>
      {shown.map((name, i) => (
        <span key={name}>
          {i > 0 && ", "}
          <code className="font-mono text-foreground">{name}</code>
        </span>
      ))}
      {rest > 0 && ` and ${rest} more`}
    </>
  );
}

const GAPS = {
  catalog:
    "Lifecycle coverage is unknown: task types could not be read, so this count may include finished work from types without a lifecycle.",
  definitions:
    "Definitions could not be read, so it is unknown which task types declare a lifecycle. This count may include finished work from types without one.",
  types:
    "Some task types could not be listed, so the types named here may not be every type without a lifecycle.",
} as const;

/**
 * Why a blocked count can include finished work (#398). It states the rule the
 * server already applied and which visible types it applied to; it changes no
 * count and filters no row. Shown even when the count is zero, because a zero
 * is not evidence that every type declares a lifecycle.
 *
 * `definitionsHref` is null when the caller's access excludes Definitions, so
 * the note never links to a page it cannot open.
 */
export function ReadinessNote({
  context,
  definitionsHref,
}: {
  context: ReadinessContext;
  definitionsHref: string | null;
}) {
  const { legacy, gap, restricted, schemaMasked } = context;
  const explainsTypes = legacy.length > 0 || gap !== null;
  return (
    <section
      aria-label="Lifecycle coverage"
      className="space-y-1 text-xs text-muted-foreground"
    >
      {gap && <p className="text-status-amber">{GAPS[gap]}</p>}
      {legacy.length > 0 && (
        <p>
          {schemaMasked
            ? "This credential sees no lifecycle for "
            : "No lifecycle is declared for "}
          <Types names={legacy} />. Without one only status “closed” counts as
          finished, so a task marked “done” still counts as open and keeps the
          tasks that depend on it waiting. Work whose type does declare a
          lifecycle also waits on a prerequisite of these types, whatever its
          status, until one is declared.
        </p>
      )}
      {restricted && (
        <p>
          This credential sees only some task types. Prerequisites of types it
          cannot see are counted but not named, and may lack a lifecycle too.
        </p>
      )}
      {explainsTypes &&
        (definitionsHref ? (
          <p>
            <Link to={definitionsHref} className={LINK}>
              Review lifecycles in Definitions
            </Link>
          </p>
        ) : (
          <p>
            Your access does not include Definitions. Someone who can edit them
            can declare a lifecycle.
          </p>
        ))}
    </section>
  );
}
