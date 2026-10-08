import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getArtifactMeta, getArtifactReviews } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

export function ArtifactReviewDetails({
  projectId,
  artifactKey,
}: { projectId: string; artifactKey: string }) {
  const [before, setBefore] = useState<number>();
  const meta = useQuery({
    queryKey: ["artifact-meta", projectId, artifactKey],
    queryFn: () => getArtifactMeta(projectId, artifactKey),
  });
  const reviews = useQuery({
    queryKey: ["artifact-reviews", projectId, artifactKey, before],
    queryFn: () => getArtifactReviews(projectId, artifactKey, before),
  });
  if (meta.isPending) return <p>Loading artifact provenance and review…</p>;
  if (meta.isError)
    return (
      <p role="alert">
        Could not load artifact provenance.{" "}
        <Button onClick={() => meta.refetch()}>Retry</Button>
      </p>
    );
  const p = meta.data.pointer;
  const producer = p.provenance;
  const review = p.review;
  return (
    <section
      aria-label="Artifact provenance and review"
      className="space-y-3 border-b border-border pb-4 text-sm"
    >
      <Badge variant="secondary">{review?.state ?? "unreviewed"}</Badge>
      <p className="text-muted-foreground">
        Review records a writer’s decision. A matching hash verifies bytes, not
        content safety.
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 break-all">
        <dt>Producer</dt>
        <dd>{producer?.principal_id ?? "Unknown (legacy artifact)"}</dd>
        <dt>Participant (client-supplied)</dt>
        <dd>{producer?.participant_id ?? "Unknown"}</dd>
        <dt>Produced</dt>
        <dd>
          {producer ? new Date(producer.created_at).toISOString() : "Unknown"}
        </dd>
        <dt>Client (client-supplied)</dt>
        <dd>
          {producer?.client_name ?? "Unknown"}{" "}
          {producer?.client_version ?? "(version unknown)"}
        </dd>
        {p.restored_from && (
          <>
            <dt>Restored from</dt>
            <dd>{p.restored_from}</dd>
            <dt>Restored by</dt>
            <dd>{p.revision_creation?.principal_id ?? "Unknown"}</dd>
            <dt>Restoring participant (client-supplied)</dt>
            <dd>{p.revision_creation?.participant_id ?? "Unknown"}</dd>
            <dt>Restored at</dt>
            <dd>
              {p.revision_creation
                ? new Date(p.revision_creation.created_at).toISOString()
                : "Unknown"}
            </dd>
          </>
        )}
        {review?.latest && (
          <>
            <dt>Reviewer</dt>
            <dd>{review.latest.principal_id}</dd>
            <dt>Decision</dt>
            <dd>
              {review.latest.decision} at{" "}
              {new Date(review.latest.created_at).toISOString()}
            </dd>
            <dt>Reason</dt>
            <dd>{review.latest.reason ?? "No reason supplied"}</dd>
          </>
        )}
      </dl>
      {producer && (
        <details>
          <summary>Client-supplied participant and environment</summary>
          <pre className="whitespace-pre-wrap">
            {JSON.stringify(producer.environment, null, 2)}
          </pre>
        </details>
      )}
      {p.restored_from && p.revision_creation && (
        <details>
          <summary>Restoring client and environment (client-supplied)</summary>
          <pre className="whitespace-pre-wrap">
            {JSON.stringify(
              {
                client_name: p.revision_creation.client_name,
                client_version: p.revision_creation.client_version,
                environment: p.revision_creation.environment,
              },
              null,
              2,
            )}
          </pre>
        </details>
      )}
      {(p.tombstoned || p.blob_deleted_at != null) && (
        <p>
          Content is unavailable; provenance and review history remain
          available.
        </p>
      )}
      <details>
        <summary>Review history</summary>
        {reviews.isPending && <p>Loading review history…</p>}
        {reviews.isError && (
          <p role="alert">
            Could not load review history.{" "}
            <Button onClick={() => reviews.refetch()}>Retry</Button>
          </p>
        )}
        {reviews.data?.items.length === 0 && <p>No reviews recorded.</p>}
        <ul>
          {reviews.data?.items.map((event) => (
            <li key={event.review_revision}>
              #{event.review_revision} {event.decision} — {event.principal_id} —{" "}
              {new Date(event.created_at).toISOString()}
              {event.reason && <p>{event.reason}</p>}
            </li>
          ))}
        </ul>
        {reviews.data?.next_revision && (
          <Button
            onClick={() => setBefore(reviews.data.next_revision ?? undefined)}
          >
            Older reviews
          </Button>
        )}
        {before !== undefined && (
          <Button onClick={() => setBefore(undefined)}>Newest reviews</Button>
        )}
      </details>
    </section>
  );
}
