import { ArtifactReviewDetails } from "@/components/artifact-review-details";
import { getArtifactMeta, getArtifactReviews } from "@/lib/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  getArtifactMeta: vi.fn(),
  getArtifactReviews: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function show() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ArtifactReviewDetails projectId="p" artifactKey="sources/report.txt" />
    </QueryClientProvider>,
  );
}
it("keeps producer and rejected review visible when content is deleted", async () => {
  vi.mocked(getArtifactMeta).mockResolvedValue({
    ok: true,
    pointer: {
      r2_key: "sources/report.txt",
      kind: "report",
      resource: null,
      sha256: "hash",
      bytes: 5,
      fence: null,
      mime_type: "text/plain",
      produced_at: 1,
      produced_by: "producer",
      expires_at: null,
      tombstoned: 1,
      tags: [],
      lineage_id: null,
      revision: null,
      restored_from: null,
      provenance: {
        principal_id: "producer",
        participant_id: "session",
        created_at: 1,
        client_name: "cli",
        client_version: "1",
        environment: {},
      },
      review: {
        state: "rejected",
        review_revision: 1,
        latest: {
          artifact_key: "sources/report.txt",
          review_revision: 1,
          principal_id: "reviewer",
          participant_id: "review-session",
          created_at: 2,
          decision: "rejected",
          reason: "Incorrect evidence",
        },
      },
    },
  });
  vi.mocked(getArtifactReviews).mockResolvedValue({
    ok: true,
    items: [],
    next_revision: null,
  });
  show();
  expect(await screen.findByText("producer")).toBeTruthy();
  expect(screen.getByText("reviewer")).toBeTruthy();
  expect(screen.getByText("Incorrect evidence")).toBeTruthy();
  expect(screen.getByText(/Content is unavailable/)).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: /trust|reject|revoke/i }),
  ).toBeNull();
});
it("shows loading and metadata failure without claiming trust", async () => {
  vi.mocked(getArtifactMeta).mockRejectedValue(new Error("offline"));
  vi.mocked(getArtifactReviews).mockResolvedValue({
    ok: true,
    items: [],
    next_revision: null,
  });
  show();
  expect(screen.getByText(/Loading artifact provenance/)).toBeTruthy();
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText("trusted")).toBeNull();
});
