import { ApiError } from "@/lib/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { WhoamiResponse } from "@tila/schemas";
import { type InputHTMLAttributes, useId } from "react";
export const inputClass =
  "rounded-md border border-border bg-background px-3 py-2 text-sm w-full";
export const split = (value: string) =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
export const revision = (value: number) => ({
  expected_revision: value,
  idempotency_key: crypto.randomUUID(),
});
export function Field({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const id = useId();
  return (
    <label htmlFor={id} className="grid gap-1 text-xs text-muted-foreground">
      {label}
      <input id={id} className={inputClass} {...props} />
    </label>
  );
}
export function Failure({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-sm text-status-red">
      {error instanceof ApiError && error.status === 412
        ? "This changed elsewhere. Your input is preserved. Refresh the revision and review before saving again."
        : error instanceof Error
          ? error.message
          : "The operation failed."}
    </p>
  );
}
export function useAction<T>(
  project: string,
  send: (input: T) => Promise<unknown>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["queue", project] }),
        client.invalidateQueries({ queryKey: ["queue-attempt", project] }),
      ]);
    },
  });
}
export function rights(identity: WhoamiResponse | undefined, project: string) {
  const role = identity?.project_id === project ? identity.role : undefined;
  const write = !!role && role !== "viewer" && identity?.permission !== "read";
  const has = (...caps: string[]) =>
    !identity?.policy ||
    caps.every((cap) =>
      (identity.policy?.capabilities as string[]).includes(cap),
    );
  const manage = write && (role === "maintainer" || role === "owner");
  return {
    edit: write && has("tasks:write"),
    operate: write && has("tasks:write", "claims:renew"),
    configure: manage && has("schema:write"),
    reconcile: manage && has("tasks:write", "claims:renew"),
    force: manage && has("tasks:write", "claims:acquire", "schema:write"),
  };
}
