import { Button } from "@/components/ui/button";
import { useWhoami } from "@/hooks/use-admin";
import { useWorkCatalog } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { rights } from "@/lib/rights";
import { Plus } from "lucide-react";
import { Link, useLocation } from "react-router";

/**
 * Opens the create drawer on the task list. Shown only when this credential
 * may create at least one declared type; the server checks again on submit.
 */
export function NewTaskLink() {
  const { projectId } = useAuth();
  const location = useLocation();
  const whoami = useWhoami();
  const catalog = useWorkCatalog();
  const allowed = rights(whoami.data, projectId ?? "");
  const any = (catalog.data?.types ?? []).some(
    (entry) =>
      entry.declaration === "declared" && allowed.createTask(entry.type),
  );
  if (!any) return null;
  const params = new URLSearchParams(location.search);
  params.set("create", "task");
  return (
    <Button asChild size="sm" className="ml-auto">
      <Link to={{ pathname: `/p/${projectId}/tasks`, search: `?${params}` }}>
        <Plus aria-hidden="true" />
        New task
      </Link>
    </Button>
  );
}

/** Opens the record create drawer for a declared record type. */
export function NewRecordLink({
  type,
  declared,
}: {
  type: string | undefined;
  declared: boolean;
}) {
  const { projectId } = useAuth();
  const location = useLocation();
  const whoami = useWhoami();
  const allowed = rights(whoami.data, projectId ?? "");
  if (!type || !declared || !allowed.writeRecord(type)) return null;
  const params = new URLSearchParams(location.search);
  params.set("create", "record");
  params.set("type", type);
  return (
    <Button asChild size="sm" className="ml-auto">
      <Link to={{ pathname: `/p/${projectId}/records`, search: `?${params}` }}>
        <Plus aria-hidden="true" />
        New record
      </Link>
    </Button>
  );
}
