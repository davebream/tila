import { ArtifactReviewDetails } from "@/components/artifact-review-details";
import {
  ApiError,
  getArtifactBlob,
  getArtifactHistory,
  getArtifactMeta,
  getArtifactReviews,
} from "@/lib/api";
import { encodeArtifactKey, parseArtifactKey } from "@/lib/utils";
import { ArtifactDetailPage } from "@/pages/artifact-detail";
import { ArtifactsPage } from "@/pages/artifacts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ArtifactHistoryResponse, ArtifactRevision } from "@tila/schemas";
import { RouterProvider, createMemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getArtifactMeta: vi.fn(),
  getArtifactReviews: vi.fn(),
  getArtifactHistory: vi.fn(),
  getArtifactBlob: vi.fn(),
}));
let activeProject = "p";
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ projectId: activeProject }),
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

function revision(
  number: number,
  overrides: Partial<ArtifactRevision> = {},
): ArtifactRevision {
  return {
    r2_key: `versioned/p/report/${number}/${"a".repeat(64)}.txt`,
    resource: "task:report",
    kind: "report",
    sha256: "a".repeat(64),
    bytes: 2048,
    fence: null,
    mime_type: "text/plain",
    produced_at: 1700000000000,
    produced_by: "writer",
    expires_at: null,
    tombstoned: 0,
    tags: ["report", "release"],
    lineage_id: "report",
    revision: number,
    restored_from: null,
    ...overrides,
  };
}
function history(
  items: ArtifactRevision[],
  next: string | null = null,
): ArtifactHistoryResponse {
  return {
    ok: true,
    items,
    meta: { total: items.length, limit: 20, next_cursor: next },
  };
}
function showDetail(key = revision(2).r2_key) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  const router = createMemoryRouter(
    [
      { path: "/p/:projectId/artifacts", element: <ArtifactsPage /> },
      { path: "/p/:projectId/artifacts/*", element: <ArtifactDetailPage /> },
    ],
    {
      initialEntries: [
        `/p/${activeProject}/artifacts/${encodeArtifactKey(key)}`,
      ],
    },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe("artifact drawer version history", () => {
  beforeEach(() => {
    activeProject = "p";
    vi.mocked(getArtifactMeta).mockResolvedValue({
      ok: true,
      pointer: revision(2),
    });
    vi.mocked(getArtifactReviews).mockResolvedValue({
      ok: true,
      items: [],
      next_revision: null,
    });
    vi.mocked(getArtifactBlob).mockImplementation(
      async (_project, key) =>
        new Response(`Preview: ${key}`, {
          headers: { "Content-Type": "text/plain" },
        }),
    );
    vi.mocked(getArtifactHistory).mockResolvedValue(
      history([revision(2), revision(1, { tags: [] })]),
    );
  });

  it("shows all fields in server order and identifies the viewed revision", async () => {
    showDetail();
    const table = await screen.findByRole("table", {
      name: "Artifact version history",
    });
    await within(table).findByRole("link", { name: "#2" });
    expect(
      within(table)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["#2", "#1"]);
    expect(within(table).getByRole("link", { name: "#2" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(table).getByText("Viewing")).toBeInTheDocument();
    expect(within(table).getAllByTitle("a".repeat(64))[0]).toHaveTextContent(
      "a".repeat(12),
    );
    expect(within(table).getAllByText("2.0 KB")).toHaveLength(2);
    expect(table.querySelector("time")).toHaveAttribute(
      "datetime",
      new Date(1700000000000).toISOString(),
    );
    expect(within(table).getByText("release")).toBeInTheDocument();
    expect(within(table).getByText("—")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "report · revision 2" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "p" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /restore/i }),
    ).not.toBeInTheDocument();
  });

  it("paginates, opens an older revision, resets its cursor, and supports Back and close", async () => {
    vi.mocked(getArtifactHistory).mockImplementation(
      async (_project, _key, params) =>
        params?.cursor
          ? history([revision(1)])
          : history([revision(2)], "older"),
    );
    const router = showDetail();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Older versions" }),
    );
    await screen.findByRole("link", { name: "#1" });
    expect(getArtifactHistory).toHaveBeenLastCalledWith(
      "p",
      revision(2).r2_key,
      { limit: 20, cursor: "older" },
    );
    await user.click(screen.getByRole("button", { name: "Newest versions" }));
    await screen.findByRole("link", { name: "#2" });
    await user.click(screen.getByRole("button", { name: "Older versions" }));
    await user.click(await screen.findByRole("link", { name: "#1" }));
    await waitFor(() =>
      expect(getArtifactHistory).toHaveBeenLastCalledWith(
        "p",
        revision(1).r2_key,
        { limit: 20, cursor: undefined },
      ),
    );
    expect(
      screen.queryByRole("button", { name: "Newest versions" }),
    ).not.toBeInTheDocument();
    await user.click(
      await screen.findByRole("button", { name: "Older versions" }),
    );
    expect(await screen.findByText("Viewing")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "#1" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await act(() => router.navigate(-1));
    expect(
      await screen.findByRole("heading", { name: "report · revision 2" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(
      await screen.findByRole("heading", { name: "Artifacts" }),
    ).toBeInTheDocument();
  });

  it("keeps history available after blob failure, including deleted and legacy metadata", async () => {
    const legacy = revision(1, {
      r2_key: "sources/task-1/a #?%.txt",
      lineage_id: null,
      revision: null,
      tombstoned: 1,
      tags: [],
    });
    vi.mocked(getArtifactHistory).mockResolvedValue(
      history([legacy, revision(2, { blob_deleted_at: 1 })]),
    );
    vi.mocked(getArtifactBlob).mockRejectedValue(
      new ApiError("http-410", "Content gone"),
    );
    showDetail(legacy.r2_key);
    expect(await screen.findByText("Content gone")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Legacy" })).toHaveAttribute(
      "href",
      `/p/p/artifacts/${encodeArtifactKey(legacy.r2_key)}`,
    );
    expect(screen.getAllByText("Content unavailable")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "task-1" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "task-1" })).toHaveAttribute(
      "href",
      "/p/p/tasks/task-1",
    );
  });

  it("shows loading and empty states, and retries history independently", async () => {
    let rejectHistory!: (reason: Error) => void;
    vi.mocked(getArtifactHistory).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectHistory = reject;
        }),
    );
    showDetail();
    expect(
      await screen.findByRole("table", { name: "Artifact version history" }),
    ).toHaveAttribute("aria-busy", "true");
    await act(async () => rejectHistory(new Error("History unavailable")));
    const region = screen.getByRole("region", { name: "Version history" });
    expect(await within(region).findByRole("alert")).toHaveTextContent(
      "History unavailable",
    );
    vi.mocked(getArtifactHistory).mockResolvedValueOnce(history([]));
    await userEvent.click(
      within(region).getByRole("button", { name: "Retry" }),
    );
    expect(
      await screen.findByText("No version history available."),
    ).toBeInTheDocument();
    expect(getArtifactBlob).toHaveBeenCalledTimes(1);
  });

  it("isolates projects and artifacts and resets pagination on project change", async () => {
    vi.mocked(getArtifactHistory).mockImplementation(
      async (project, _key, params) =>
        history(
          [revision(params?.cursor ? 1 : 2, { tags: [project] })],
          params?.cursor ? null : "older",
        ),
    );
    const router = showDetail();
    await userEvent.click(
      await screen.findByRole("button", { name: "Older versions" }),
    );
    await screen.findByRole("link", { name: "#1" });
    activeProject = "other";
    await act(() =>
      router.navigate(`/p/other/artifacts/${revision(2).r2_key}`),
    );
    await waitFor(() =>
      expect(getArtifactHistory).toHaveBeenLastCalledWith(
        "other",
        revision(2).r2_key,
        { limit: 20, cursor: undefined },
      ),
    );
    expect(await screen.findByText("other")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Newest versions" }),
    ).not.toBeInTheDocument();
    await act(() =>
      router.navigate("/p/other/artifacts/sources/task-2/new.txt"),
    );
    await waitFor(() =>
      expect(getArtifactHistory).toHaveBeenLastCalledWith(
        "other",
        "sources/task-2/new.txt",
        { limit: 20, cursor: undefined },
      ),
    );
  });

  it("labels versioned keys without treating the project as a task", () => {
    expect(parseArtifactKey(revision(2).r2_key)).toEqual({
      entity: "",
      label: "report · revision 2",
    });
    expect(parseArtifactKey("test/task-1/hash.txt")).toEqual({
      entity: "task-1",
      label: "task-1",
    });
    expect(parseArtifactKey("plain.txt")).toEqual({
      entity: "",
      label: "plain.txt",
    });
  });
});
