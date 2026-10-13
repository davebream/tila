import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { appendJournalReport, whoami } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import {
  JournalAppendRequestSchema,
  hasNamespaceRestrictions,
} from "@tila/schemas";
import { useRef, useState } from "react";
import { Link } from "react-router";

export function ProjectReportDetails({
  data,
  projectId,
}: { data: Record<string, unknown>; projectId: string | null }) {
  const parsed = JournalAppendRequestSchema.safeParse(data);
  const target = parsed.success ? parsed.data.target : undefined;
  const resource =
    target && target.kind !== "project" ? target.resource : undefined;
  const path = resource?.startsWith("record:")
    ? `/records/${resource.slice(7).split("/").map(encodeURIComponent).join("/")}`
    : resource
      ? `/tasks/${encodeURIComponent(resource.slice(resource.indexOf(":") + 1))}`
      : undefined;
  return (
    <div className="space-y-1 text-xs">
      <strong>Project report</strong>{" "}
      <span>
        {typeof data.event_name === "string"
          ? data.event_name
          : "Unknown event"}
      </span>
      {typeof data.event_version === "number" && (
        <span> v{data.event_version}</span>
      )}
      <p>Caller-reported observation</p>
      {typeof data.occurred_at === "string" && (
        <p>Occurred (reported): {data.occurred_at}</p>
      )}
      {typeof data.correlation_id === "string" && (
        <p>Correlation: {data.correlation_id}</p>
      )}
      {typeof data.corrects_seq === "number" && (
        <p>Corrects report #{data.corrects_seq}</p>
      )}
      {target && (
        <p>
          {target.kind === "claim"
            ? "Claim-bound report"
            : target.kind === "resource"
              ? "Resource observation"
              : "Project-level report"}
        </p>
      )}
      {path && projectId && (
        <Link
          className="underline"
          to={`/p/${encodeURIComponent(projectId)}${path}`}
        >
          {resource}
        </Link>
      )}
      {parsed.success &&
        parsed.data.artifact_refs?.map((key) => (
          <p key={key}>
            <Link
              className="underline"
              to={`/p/${encodeURIComponent(projectId ?? "")}/artifacts/${key.split("/").map(encodeURIComponent).join("/")}`}
            >
              {key}
            </Link>
          </p>
        ))}
    </div>
  );
}

export function JournalReportForm({
  projectId,
  onAccepted,
}: { projectId: string; onAccepted: () => void }) {
  const identity = useQuery({
    queryKey: ["journal-identity", projectId],
    queryFn: whoami,
    refetchInterval: 30_000,
  });
  const policy = identity.data?.policy;
  const allowed =
    !identity.isError &&
    identity.fetchStatus !== "paused" &&
    identity.data?.project_id === projectId &&
    policy &&
    policy.role !== "viewer" &&
    policy.capabilities.includes("journal:append") &&
    !hasNamespaceRestrictions(policy);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [version, setVersion] = useState("1");
  const [kind, setKind] = useState("project");
  const [resource, setResource] = useState("");
  const [fence, setFence] = useState("");
  const [json, setJson] = useState("{}");
  const [correlation, setCorrelation] = useState("");
  const [occurred, setOccurred] = useState("");
  const [correction, setCorrection] = useState("");
  const [artifacts, setArtifacts] = useState("");
  const [error, setError] = useState("");
  const [accepted, setAccepted] = useState<number>();
  const [pending, setPending] = useState(false);
  const submission = useRef<{ body: string; key: string } | undefined>(
    undefined,
  );
  if (!allowed) return null;
  return (
    <section>
      <Button
        variant="outline"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        Report event
      </Button>
      {accepted !== undefined && (
        <output>Accepted project report #{accepted}</output>
      )}
      {open && (
        <form
          className="mt-3 space-y-3 rounded border border-border p-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (pending) return;
            setError("");
            try {
              const input = JournalAppendRequestSchema.parse({
                event_name: name,
                event_version: Number(version),
                data: JSON.parse(json),
                target:
                  kind === "project"
                    ? { kind }
                    : {
                        kind,
                        resource,
                        ...(kind === "claim" ? { fence: Number(fence) } : {}),
                      },
                ...(correlation ? { correlation_id: correlation } : {}),
                ...(occurred ? { occurred_at: occurred } : {}),
                ...(correction ? { corrects_seq: Number(correction) } : {}),
                ...(artifacts.trim()
                  ? {
                      artifact_refs: artifacts
                        .split("\n")
                        .map((line) => line.trim())
                        .filter(Boolean),
                    }
                  : {}),
              });
              const body = JSON.stringify(input);
              if (submission.current?.body !== body)
                submission.current = { body, key: crypto.randomUUID() };
              setPending(true);
              const receipt = await appendJournalReport(
                projectId,
                input,
                submission.current.key,
              );
              setAccepted(receipt.event.seq);
              submission.current = undefined;
              setOpen(false);
              onAccepted();
            } catch (failure) {
              setError(
                failure instanceof Error
                  ? failure.message
                  : "Unable to append report",
              );
            } finally {
              setPending(false);
            }
          }}
        >
          <p className="text-sm">
            Reports are visible to the project. They record your observation and
            do not change work state.
          </p>
          <fieldset disabled={pending} className="grid gap-3 sm:grid-cols-2">
            <label htmlFor="report-name">
              Event name
              <Input
                id="report-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="pipeline.tests_passed"
                required
              />
            </label>
            <label htmlFor="report-version">
              Payload version
              <Input
                id="report-version"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                type="number"
                min="1"
                required
              />
            </label>
            <label>
              Report target
              <select
                className="block w-full rounded border bg-background p-2"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
              >
                <option value="project">Project</option>
                <option value="resource">Resource observation</option>
                <option value="claim">Claim-bound report</option>
              </select>
            </label>
            {kind !== "project" && (
              <label htmlFor="report-resource">
                Resource
                <Input
                  id="report-resource"
                  value={resource}
                  onChange={(e) => setResource(e.target.value)}
                  placeholder="task:T-142"
                  required
                />
              </label>
            )}
            {kind === "claim" && (
              <label htmlFor="report-fence">
                Current fence
                <Input
                  id="report-fence"
                  value={fence}
                  onChange={(e) => setFence(e.target.value)}
                  type="number"
                  min="1"
                  required
                />
              </label>
            )}
            <label htmlFor="report-correlation">
              Correlation ID
              <Input
                id="report-correlation"
                value={correlation}
                onChange={(e) => setCorrelation(e.target.value)}
              />
            </label>
            <label htmlFor="report-occurred">
              Occurred at (optional)
              <Input
                id="report-occurred"
                value={occurred}
                onChange={(e) => setOccurred(e.target.value)}
                placeholder="2026-10-12T12:00:00Z"
              />
            </label>
            <label htmlFor="report-correction">
              Corrects report sequence
              <Input
                id="report-correction"
                value={correction}
                onChange={(e) => setCorrection(e.target.value)}
                type="number"
                min="1"
              />
            </label>
            <label>
              Artifact references (one per line)
              <textarea
                className="block w-full rounded border bg-background p-2"
                value={artifacts}
                onChange={(e) => setArtifacts(e.target.value)}
              />
            </label>
            <label className="sm:col-span-2">
              JSON data (16 KiB maximum)
              <textarea
                className="block min-h-24 w-full rounded border bg-background p-2 font-mono"
                value={json}
                onChange={(e) => setJson(e.target.value)}
                required
              />
            </label>
          </fieldset>
          {error && (
            <p role="alert" className="text-red-500 whitespace-pre-wrap">
              {error}
            </p>
          )}
          <Button type="submit" disabled={pending}>
            {pending ? "Submitting…" : "Submit report"}
          </Button>
        </form>
      )}
    </section>
  );
}
