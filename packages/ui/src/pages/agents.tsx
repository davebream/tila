import { DeliveryDetail } from "@/components/delivery-trace";
import { Drawer } from "@/components/ui/drawer";
import { useAuth } from "@/hooks/use-auth";
import { useTimeTick } from "@/hooks/use-time-tick";
import { listAgents } from "@/lib/api";
import { deriveBindingView, leaseCountdown } from "@/lib/lease";
import { formatTime } from "@/lib/time";
import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { Link, useNavigate, useParams } from "react-router";

const BINDING_LABEL = {
  none: "No binding",
  attached: "Attached",
  expired: "Expired",
  replaced: "Replaced",
  released: "Released",
} as const;

export function AgentsPage() {
  // Re-render every second so lease expiry is recomputed even when polling fails.
  useTimeTick(1000);
  const now = Date.now();
  const { projectId } = useAuth();
  const { agentId, deliveryId } = useParams();
  const navigate = useNavigate();
  const opener = useRef<HTMLAnchorElement>(null);
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
      {agents.error && (
        <p role="alert">
          {agents.error.message}
          {agents.data &&
            ` Showing data last observed at ${formatTime(agents.dataUpdatedAt)}; leases are recomputed locally.`}
        </p>
      )}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-sm" aria-label="Agents">
          <thead className="bg-card">
            <tr>
              {[
                "Agent",
                "Mailbox",
                "Epoch",
                "Wake",
                "Lease until",
                "Deliveries",
              ].map((label) => (
                <th key={label} className="p-3">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {agents.data?.agents.map(({ agent: row, binding }) => {
              const view = deriveBindingView(binding, now);
              return (
                <tr key={row.id} className="border-t border-border">
                  <th className="p-3 font-medium" scope="row">
                    {row.name}
                    <span className="block text-xs text-muted-foreground">
                      {row.id}
                    </span>
                  </th>
                  <td className="p-3">
                    {row.archived ? "Archived" : BINDING_LABEL[view.kind]}
                    {view.kind !== "none" && view.redacted && (
                      <span className="block text-xs text-muted-foreground">
                        Details hidden
                      </span>
                    )}
                  </td>
                  <td className="p-3 font-mono">{row.binding_epoch}</td>
                  <td className="p-3">{binding?.mechanism ?? "None"}</td>
                  <td className="p-3">
                    {view.kind === "none" ? (
                      "—"
                    ) : (
                      <>
                        {new Date(view.expiresAtMs).toLocaleString()}
                        <span className="block text-xs text-muted-foreground">
                          {view.kind === "attached" || view.kind === "expired"
                            ? `${view.kind === "attached" ? "Expires" : "Expired"} ${leaseCountdown(view.expiresAtMs, now)}`
                            : `Lease ${view.kind}`}
                        </span>
                      </>
                    )}
                  </td>
                  <td className="p-3">
                    <Link
                      className="text-signal-blue underline"
                      to={`/p/${projectId}/deliveries?agent=${encodeURIComponent(row.id)}`}
                      aria-label={`Deliveries for ${row.name}`}
                    >
                      Deliveries
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {agents.data?.agents.length === 0 && <p>No agents registered.</p>}
      <p className="text-sm text-muted-foreground">
        <Link
          ref={opener}
          className="text-signal-blue underline"
          to={`/p/${projectId}/deliveries`}
        >
          Browse deliveries
        </Link>{" "}
        to trace messages to their wake, acknowledgement and work result.
        Browsing requires conversation management authority. Fetching and
        acknowledging remain with the active mailbox consumer.
      </p>
      {projectId && agentId && deliveryId && (
        <Drawer
          title="Delivery trace"
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
