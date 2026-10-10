import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { useAuth } from "@/hooks/use-auth";
import { inspectDelivery, listAgents } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";

export function AgentsPage() {
  const { projectId } = useAuth();
  const { agentId, deliveryId } = useParams();
  const navigate = useNavigate();
  const [agent, setAgent] = useState("");
  const [delivery, setDelivery] = useState("");
  const opener = useRef<HTMLButtonElement>(null);
  const agents = useQuery({
    queryKey: ["agents", projectId],
    queryFn: () => listAgents(projectId as string),
    enabled: !!projectId,
    refetchInterval: 5000,
  });
  return (
    <div className="space-y-6 p-4 md:p-6">
      <header>
        <h1 className="font-logo text-2xl">Agents</h1>
        <p className="text-sm text-muted-foreground">
          Durable identities and their current mailbox consumers.
        </p>
      </header>
      {agents.isPending && <p>Loading agents…</p>}
      {agents.error && <p role="alert">{agents.error.message}</p>}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-sm" aria-label="Agents">
          <thead className="bg-card">
            <tr>
              {["Agent", "Mailbox", "Epoch", "Wake", "Lease until"].map(
                (label) => (
                  <th key={label} className="p-3">
                    {label}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {agents.data?.agents.map(({ agent: row, binding }) => (
              <tr key={row.id} className="border-t border-border">
                <th className="p-3 font-medium" scope="row">
                  {row.name}
                  <span className="block text-xs text-muted-foreground">
                    {row.id}
                  </span>
                </th>
                <td className="p-3">
                  {row.archived
                    ? "Archived"
                    : binding?.state === "active" &&
                        binding.lease_expires_at > Date.now()
                      ? "Attached"
                      : "Offline"}
                </td>
                <td className="p-3 font-mono">{row.binding_epoch}</td>
                <td className="p-3">{binding?.mechanism ?? "None"}</td>
                <td className="p-3">
                  {binding
                    ? new Date(binding.lease_expires_at).toLocaleString()
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {agents.data?.agents.length === 0 && <p>No agents registered.</p>}
      <form
        className="flex flex-wrap items-end gap-3 rounded-lg border border-border p-4"
        onSubmit={(event) => {
          event.preventDefault();
          navigate(
            `/p/${projectId}/agents/${encodeURIComponent(agent)}/deliveries/${encodeURIComponent(delivery.trim())}`,
          );
        }}
      >
        <label className="grid gap-1 text-sm">
          Agent
          <select
            aria-label="Agent"
            className="rounded border border-border bg-background p-2"
            value={agent}
            onChange={(event) => setAgent(event.target.value)}
            required
          >
            <option value="">Choose agent</option>
            {agents.data?.agents.map(({ agent: row }) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Delivery ID
          <input
            className="rounded border border-border bg-background p-2 font-mono"
            value={delivery}
            onChange={(event) => setDelivery(event.target.value)}
            placeholder="UUID from inbox or dispatch metadata"
            pattern="[0-9a-fA-F-]{36}"
            required
          />
        </label>
        <Button ref={opener} type="submit">
          Inspect delivery
        </Button>
        <p className="basis-full text-xs text-muted-foreground">
          Inspection requires conversation management authority. Fetching and
          acknowledging remain with the active mailbox consumer.
        </p>
      </form>
      {projectId && agentId && deliveryId && (
        <Drawer
          title="Delivery inspection"
          restoreFocus={() =>
            requestAnimationFrame(() => opener.current?.focus())
          }
          onClose={() => {
            navigate(`/p/${projectId}/agents`);
            requestAnimationFrame(() => opener.current?.focus());
          }}
        >
          <DeliveryDetail
            project={projectId}
            agent={agentId}
            delivery={deliveryId}
          />
        </Drawer>
      )}
    </div>
  );
}
export function DeliveryDetail({
  project,
  agent,
  delivery,
}: { project: string; agent: string; delivery: string }) {
  const result = useQuery({
    queryKey: ["delivery", project, agent, delivery],
    queryFn: () => inspectDelivery(project, agent, delivery),
    refetchInterval: 5000,
    retry: false,
  });
  const row = result.data?.delivery;
  return (
    <div className="space-y-4 p-6">
      {result.isPending && <p>Loading delivery…</p>}
      {result.error && <p role="alert">{result.error.message}</p>}
      {row && (
        <>
          <p className="break-all font-mono text-xs">{row.id}</p>
          <p className="text-lg">{result.data?.reason.replaceAll("-", " ")}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            {Object.entries({
              Agent: row.agent_id,
              State: row.state,
              Disposition: row.disposition ?? "Not acknowledged",
              "Target epoch": row.target_epoch ?? "Any current binding",
              "Fetched epoch": row.fetched_epoch ?? "Not fetched",
              "Acknowledged epoch": row.acked_epoch ?? "Not acknowledged",
              Suppression: row.wake_suppressed ?? "None",
              Expires: new Date(row.expires_at).toLocaleString(),
            }).map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-muted-foreground">
            Acknowledgement records accepted processing or decline. It never
            means task completion.
          </p>
          <h2 className="font-medium">Wake attempts</h2>
          <ol className="space-y-2">
            {result.data?.attempts.map((attempt) => (
              <li
                key={attempt.id}
                className="rounded border border-border p-3 text-sm"
              >
                {attempt.outcome} · epoch {attempt.binding_epoch} · publication{" "}
                {attempt.publish_gen}
                <time
                  className="block text-xs text-muted-foreground"
                  dateTime={new Date(attempt.created_at).toISOString()}
                >
                  {new Date(attempt.created_at).toLocaleString()}
                </time>
              </li>
            ))}
          </ol>
          {result.data?.attempts.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No wake attempts recorded.
            </p>
          )}
        </>
      )}
    </div>
  );
}
