import { TextAreaField } from "@/components/ui/form-fields";
import { TaskCreateDrawer } from "@/components/work/task-create";
import { ApiError, correctAttempt, createTaskRelationship } from "@/lib/api";
import { failureKind } from "@/lib/mutation-errors";
import {
  editOperation,
  operationKey,
  releaseOperation,
  stageOperation,
  useOperationDraft,
} from "@/lib/operation-draft";
import type { Entity, WorkPresentation } from "@tila/schemas";
import { presentedTitle } from "@tila/schemas";
import { useRef } from "react";
import { z } from "zod";

const Value = z.object({ reason: z.string() });
const Command = z.object({ key: z.string(), reason: z.string() });
type Command = z.infer<typeof Command>;

interface FollowUpDrawerProps {
  project: string;
  principal: string;
  task: Entity;
  attemptId: string;
  presentation?: WorkPresentation;
  close: () => void;
}

/**
 * Create corrective work for a finished attempt. The new task is linked
 * `discovered-from` the original task and recorded as a correction of the
 * attempt; the attempt's result and evidence are never rewritten. Every step
 * is idempotent, so a retry after any failure finishes the remaining links.
 */
export function FollowUpDrawer({
  project,
  principal,
  task,
  attemptId,
  presentation,
  close,
}: FollowUpDrawerProps) {
  const { draft, update, discard } = useOperationDraft(
    operationKey("follow-up", principal, project, attemptId),
    () => ({ reason: "" }),
    { value: Value, command: Command },
  );
  // Read inside the create request, which may run after this render.
  const staged = useRef<Command | null>(draft.pending?.command ?? null);
  const latest = useRef(draft);
  latest.current = draft;
  /** Freeze the correction for the current reason unless one is frozen. */
  const freeze = () => {
    if (staged.current) return staged.current;
    const next = stageOperation(latest.current, (value, id) => ({
      key: id,
      reason: value.reason.trim(),
    }));
    staged.current = next.pending?.command ?? null;
    update(() => next);
    return staged.current;
  };
  const titleField = presentation?.title ?? "title";
  const title = presentedTitle(task.data, presentation) ?? task.id;

  return (
    <TaskCreateDrawer
      title="Follow-up task"
      scope={`follow-up:${attemptId}`}
      onClose={close}
      prefill={{
        type: task.type,
        fields: { [titleField]: `Follow-up: ${title}` },
      }}
      validate={() => {
        if (!draft.value.reason.trim())
          return "Explain why follow-up work is needed.";
        freeze();
        return null;
      }}
      afterCreate={async (id) => {
        const missing = () =>
          new ApiError(
            "validation-error",
            "Explain why follow-up work is needed",
            undefined,
            400,
          );
        if (!latest.current.value.reason.trim()) throw missing();
        const command = freeze();
        if (!command) throw missing();
        try {
          // `from` was discovered from `to`: the new task points at the original.
          await createTaskRelationship(project, {
            from_id: id,
            to_id: task.id,
            type: "discovered-from",
          });
          await correctAttempt(project, attemptId, {
            idempotency_key: command.key,
            task_id: id,
            reason: command.reason,
          });
        } catch (error) {
          // A definite refusal unfreezes the reason so it can be corrected;
          // the next Retry links the existing task with a new key.
          if (failureKind(error) !== "unconfirmed") {
            staged.current = null;
            update(releaseOperation);
          }
          throw error;
        }
        discard();
      }}
    >
      <div className="space-y-3 rounded-md border border-border p-4 text-sm">
        <p>
          Follows up on attempt <span className="font-mono">{attemptId}</span>{" "}
          of <span className="font-mono">{task.id}</span>. Its recorded result
          and evidence stay as they are; this task is linked to them.
        </p>
        <TextAreaField
          label="Why is follow-up needed?"
          required
          maxLength={2000}
          value={draft.value.reason}
          disabled={Boolean(draft.pending)}
          onChange={(e) =>
            update((d) => editOperation(d, { reason: e.target.value }))
          }
        />
      </div>
    </TaskCreateDrawer>
  );
}
