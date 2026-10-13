import type { DefinitionProblem } from "@/lib/mutation-errors";
import { useEffect, useRef } from "react";

export function problemLocation(problem: DefinitionProblem): string | null {
  if (problem.path) return problem.path;
  if (problem.line !== undefined)
    return problem.column !== undefined
      ? `line ${problem.line}, column ${problem.column}`
      : `line ${problem.line}`;
  return null;
}

/**
 * Validation problems for a definition. Takes focus when it appears so a
 * keyboard or screen-reader user lands on what blocked the preview or apply.
 */
export function ProblemSummary({
  title,
  problems,
  focus = true,
}: {
  title: string;
  problems: readonly DefinitionProblem[];
  focus?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const signature = JSON.stringify(problems);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refocus when the problems change
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus, signature]);
  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      className="space-y-2 rounded-md border border-status-red/40 px-3 py-2 text-sm outline-hidden focus-visible:ring-2 focus-visible:ring-status-red/40"
    >
      <p className="font-medium text-status-red">{title}</p>
      <ul className="list-disc space-y-1 pl-5">
        {problems.map((problem) => {
          const where = problemLocation(problem);
          return (
            <li key={`${where ?? ""}:${problem.message}`}>
              {where && <code className="font-mono text-xs">{where}</code>}
              {where && ": "}
              {problem.message}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
