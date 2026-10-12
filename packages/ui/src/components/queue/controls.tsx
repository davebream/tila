import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { controlQueue } from "@/lib/api";
import type { QueueEntry, QueuePolicy } from "@tila/schemas";
import { useState } from "react";
import { Failure, Field, revision, split, useAction } from "./shared";
export function PolicyForm({
  project,
  policy,
  allowed,
}: { project: string; policy: QueuePolicy; allowed: boolean }) {
  const [execution, setExecution] = useState(
    String(policy.execution_limit ?? ""),
  );
  const [wip, setWip] = useState(String(policy.wip_limit ?? ""));
  const [base, setBase] = useState(policy.revision);
  const action = useAction(
    project,
    (command: Parameters<typeof controlQueue>[1]) =>
      controlQueue(project, command),
  );
  return (
    <details className="rounded-lg border border-border p-4">
      <summary className="cursor-pointer text-sm font-medium">
        Queue settings
      </summary>
      <form
        className="mt-4 grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          action.mutate(
            {
              action: "configure",
              command: {
                ...revision(base),
                execution_limit: Number(execution),
                wip_limit: wip ? Number(wip) : null,
                enabled: true,
              },
            },
            { onSuccess: (value) => setBase((value as QueuePolicy).revision) },
          );
        }}
      >
        <Field
          label="Execution limit"
          type="number"
          min={1}
          required
          value={execution}
          onChange={(e) => setExecution(e.target.value)}
          disabled={!allowed}
        />
        <Field
          label="WIP limit (blank means uncapped)"
          type="number"
          min={1}
          value={wip}
          onChange={(e) => setWip(e.target.value)}
          disabled={!allowed}
        />
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <Button disabled={!allowed || action.isPending}>
            Save limits and enable queue
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!allowed || action.isPending || !policy.enabled}
            onClick={() =>
              action.mutate({
                action: "configure",
                command: {
                  ...revision(policy.revision),
                  paused: !policy.paused,
                },
              })
            }
          >
            {policy.paused ? "Resume admission" : "Pause admission"}
          </Button>
          {base !== policy.revision && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setBase(policy.revision);
                action.reset();
              }}
            >
              Use latest revision ({policy.revision})
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground sm:col-span-2">
          Pausing blocks new grants and resumed execution. Existing execution
          can finish. Saving limits preserves the current pause state.
        </p>
        <Failure error={action.error} />
      </form>
    </details>
  );
}
export function EnrollmentForm({
  project,
  task,
  allowed,
}: { project: string; task: string; allowed: boolean }) {
  const [taskId, setTaskId] = useState(task);
  const [priority, setPriority] = useState("0");
  const [target, setTarget] = useState("");
  const [capabilities, setCapabilities] = useState("");
  const [safe, setSafe] = useState(false);
  const action = useAction(
    project,
    (input: Parameters<typeof controlQueue>[1]) => controlQueue(project, input),
  );
  return (
    <details
      open={task ? true : undefined}
      className="rounded-lg border border-border p-4"
    >
      <summary className="cursor-pointer text-sm font-medium">
        Enroll work
      </summary>
      <form
        className="mt-4 grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          action.mutate({
            action: "enroll",
            command: {
              idempotency_key: crypto.randomUUID(),
              task_id: taskId,
              priority: Number(priority),
              target_principal: target || null,
              required_capabilities: split(capabilities),
              retry_policy: { retry_safe: safe },
            },
          });
        }}
      >
        <Field
          label="Task ID"
          required
          value={taskId}
          onChange={(e) => setTaskId(e.target.value)}
          disabled={!allowed}
        />
        <Field
          label="Priority"
          type="number"
          required
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          disabled={!allowed}
        />
        <Field
          label="Target principal (optional)"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          disabled={!allowed}
        />
        <Field
          label="Required capabilities (comma separated)"
          value={capabilities}
          onChange={(e) => setCapabilities(e.target.value)}
          disabled={!allowed}
        />
        <label className="text-sm">
          <input
            type="checkbox"
            checked={safe}
            onChange={(e) => setSafe(e.target.checked)}
            disabled={!allowed}
          />{" "}
          Execution is safe to retry automatically (up to three attempts)
        </label>
        <Button disabled={!allowed || action.isPending}>Enroll task</Button>
        {action.isSuccess && (
          <output>
            Work enrolled. Execution starts only after a worker obtains and
            accepts a grant.
          </output>
        )}
        <Failure error={action.error} />
      </form>
    </details>
  );
}
export function EntryEditor({
  project,
  entry,
  allowed,
  close,
}: {
  project: string;
  entry: QueueEntry;
  allowed: boolean;
  close: () => void;
}) {
  const [priority, setPriority] = useState(String(entry.priority));
  const [target, setTarget] = useState(entry.target_principal ?? "");
  const [capabilities, setCapabilities] = useState(
    entry.required_capabilities.join(", "),
  );
  const [base, setBase] = useState(entry.revision);
  const action = useAction(
    project,
    (input: Parameters<typeof controlQueue>[1]) => controlQueue(project, input),
  );
  return (
    <Drawer title={`Enrollment · ${entry.task_id}`} onClose={close}>
      <form
        className="grid gap-4 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          action.mutate(
            {
              action: "edit",
              id: entry.id,
              command: {
                ...revision(base),
                priority: Number(priority),
                target_principal: target || null,
                required_capabilities: split(capabilities),
              },
            },
            { onSuccess: close },
          );
        }}
      >
        <Field
          label="Enrollment priority"
          type="number"
          required
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
        />
        <Field
          label="Enrollment target principal"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
        <Field
          label="Enrollment capabilities"
          value={capabilities}
          onChange={(e) => setCapabilities(e.target.value)}
        />
        <Button disabled={!allowed || action.isPending}>Save enrollment</Button>
        <Button
          type="button"
          variant="outline"
          disabled={!allowed || action.isPending || entry.state !== "queued"}
          onClick={() =>
            action.mutate(
              { action: "withdraw", id: entry.id, command: revision(base) },
              { onSuccess: close },
            )
          }
        >
          Withdraw enrollment
        </Button>
        {base !== entry.revision && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setBase(entry.revision);
              action.reset();
            }}
          >
            Use latest revision ({entry.revision})
          </Button>
        )}
        <Failure error={action.error} />
      </form>
    </Drawer>
  );
}
