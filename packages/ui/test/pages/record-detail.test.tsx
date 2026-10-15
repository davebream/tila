import { RecordDetailPage } from "@/pages/record-detail";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse, delay } from "msw";
import { Route, Routes } from "react-router";
import { recordEntry, recordTypesHandler } from "../mocks/records";
import { server } from "../mocks/server";
import {
  act,
  renderWithProviders,
  screen,
  waitFor,
  within,
} from "../test-utils";

const ROUTE = "/p/test-project/records/deploy/prod";

function renderRecord() {
  return renderWithProviders(
    <Routes>
      <Route
        path="/p/:projectId/records/:type/*"
        element={<RecordDetailPage />}
      />
    </Routes>,
    { route: ROUTE },
  );
}

const record = {
  type: "deploy",
  key: "prod",
  schema_version: 1,
  value: { region: "eu" },
  value_sha256: "a".repeat(64),
  revision: 3,
  archived: 0,
  created_at: Date.now() - 100_000,
  updated_at: Date.now() - 50_000,
  updated_by: "alice-the-updater",
  tags: [],
};

const historyItem = {
  type: "deploy",
  key: "prod",
  revision: 3,
  operation: "set",
  schema_version: 1,
  value_sha256: "a".repeat(64),
  canonical_artifact_key: null,
  source_artifact_key: null,
  actor: "revision-actor",
  created_at: Date.now() - 50_000,
  message: null,
};

const meta = { total: 1, limit: 20, next_cursor: null };

const error = (status: number, code: string, message: string) => () =>
  HttpResponse.json(
    { ok: false, error: { code, message, retryable: status >= 500 } },
    { status },
  );
const forbidden = error(403, "permission-denied", "No access");
const unavailable = error(503, "do-unreachable", "Project unavailable");

function recordOk() {
  return http.get("*/projects/*/records/:type/*", () =>
    HttpResponse.json({ ok: true, record, fence: 7 }),
  );
}

function historyOk(items: unknown[] = [historyItem]) {
  return http.get("*/projects/*/records/:type/~/history/*", () =>
    HttpResponse.json({ ok: true, items, meta }),
  );
}

// The list request only feeds prev/next navigation.
const listOk = http.get("*/projects/*/records/:type", () =>
  HttpResponse.json({
    ok: true,
    items: [],
    meta: { total: 0, limit: 200, next_cursor: null },
  }),
);

describe("RecordDetailPage revision history", () => {
  test("a failed history request is an error with retry, not 'No history available'", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("*/projects/*/records/:type/~/history/*", unavailable),
      recordOk(),
      listOk,
    );
    renderRecord();

    expect(await screen.findByText("alice-the-updater")).toBeInTheDocument();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load revision history.");
    expect(screen.queryByText("No history available")).not.toBeInTheDocument();

    server.use(historyOk());
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("revision-actor")).toBeInTheDocument();
  });

  test("a forbidden history request is access denied, not empty", async () => {
    server.use(
      http.get("*/projects/*/records/:type/~/history/*", forbidden),
      recordOk(),
      listOk,
    );
    renderRecord();

    expect(
      await screen.findByText("You do not have access to revision history."),
    ).toBeInTheDocument();
    expect(screen.queryByText("No history available")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
  });

  test("shows each revision's principal and token beside the actor", async () => {
    server.use(
      historyOk([
        {
          ...historyItem,
          revision: 3,
          actor: "deploy-bot",
          principal_id: "service:deploy",
          token_id: "token-b",
        },
        {
          ...historyItem,
          revision: 2,
          actor: "deploy-bot",
          principal_id: "service:deploy",
          token_id: "token-a",
        },
        // A browser session: a principal but no credential.
        {
          ...historyItem,
          revision: 1,
          actor: "alice",
          principal_id: "user:alice",
          token_id: null,
        },
      ]),
      recordOk(),
      listOk,
    );
    renderRecord();

    const history = await screen.findByRole("table", {
      name: "Revision history",
    });
    const rows = within(history).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    // Two tokens under one display name stay distinguishable.
    expect(rows[0]).toHaveTextContent("service:deploy");
    expect(rows[0]).toHaveTextContent("token token-b");
    expect(rows[1]).toHaveTextContent("service:deploy");
    expect(rows[1]).toHaveTextContent("token token-a");
    expect(rows[2]).toHaveTextContent("user:alice");
    expect(rows[2]).not.toHaveTextContent("token");
  });

  test("shows an unrecorded author as such, not as a guess", async () => {
    server.use(
      historyOk([
        { ...historyItem, principal_id: null, token_id: null },
        // Older Worker: the fields are absent altogether.
        { ...historyItem, revision: 2 },
        // Written before principals were tracked, with a stored credential.
        { ...historyItem, revision: 1, principal_id: null, token_id: "tok-9" },
      ]),
      recordOk(),
      listOk,
    );
    renderRecord();

    const history = await screen.findByRole("table", {
      name: "Revision history",
    });
    const rows = within(history).getAllByRole("row").slice(1);
    expect(within(rows[0]).getByTitle("Not recorded")).toHaveTextContent("—");
    expect(within(rows[1]).getByTitle("Not recorded")).toHaveTextContent("—");
    expect(rows[2]).toHaveTextContent("token tok-9");
    expect(within(rows[2]).queryByTitle("Not recorded")).toBeNull();
  });

  test("a pending history request shows loading text", async () => {
    server.use(
      http.get("*/projects/*/records/:type/~/history/*", async () => {
        await delay("infinite");
      }),
      recordOk(),
      listOk,
    );
    renderRecord();

    expect(
      await screen.findByText("Loading revision history…"),
    ).toBeInTheDocument();
    expect(screen.queryByText("No history available")).not.toBeInTheDocument();
  });

  test("a successful empty history is reported as such", async () => {
    server.use(historyOk([]), recordOk(), listOk);
    renderRecord();

    expect(await screen.findByText("No history available")).toBeInTheDocument();
  });
});

describe("RecordDetailPage record", () => {
  test("a failed refresh keeps the record on screen with a stale notice", async () => {
    server.use(historyOk(), recordOk(), listOk);
    const { queryClient } = renderRecord();
    await screen.findByText("alice-the-updater");

    server.use(http.get("*/projects/*/records/:type/*", unavailable));
    await act(() => queryClient.invalidateQueries({ queryKey: ["record"] }));

    expect(
      await screen.findByText(/Showing record from .* Refresh failed/),
    ).toBeInTheDocument();
    expect(screen.getByText("alice-the-updater")).toBeInTheDocument();
  });

  test("losing access on refresh removes the record instead of keeping it as current", async () => {
    server.use(historyOk(), recordOk(), listOk);
    const { queryClient } = renderRecord();
    await screen.findByText("alice-the-updater");

    server.use(http.get("*/projects/*/records/:type/*", forbidden));
    await act(() => queryClient.invalidateQueries({ queryKey: ["record"] }));

    expect(
      await screen.findByText("You do not have access to record."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("alice-the-updater")).not.toBeInTheDocument(),
    );
  });

  test("a missing record is reported as not found", async () => {
    server.use(
      http.get(
        "*/projects/*/records/:type/*",
        error(404, "not-found", "No such record"),
      ),
      http.get("*/projects/*/records/:type/~/history/*", unavailable),
      listOk,
    );
    renderRecord();

    expect(await screen.findByText("Record not found.")).toBeInTheDocument();
  });
});

function recordWith(value: Record<string, unknown>) {
  return http.get("*/projects/*/records/:type/*", () =>
    HttpResponse.json({ ok: true, record: { ...record, value }, fence: 7 }),
  );
}

const sentence = (text: string) => (_: string, el: Element | null) =>
  el?.tagName === "P" && el.textContent === text;

function region(name: string) {
  return screen.getByRole("region", { name });
}

function fieldNames(table: HTMLElement): string[] {
  return within(table)
    .getAllByRole("row")
    .map((row) => within(row).getAllByRole("cell")[0].textContent ?? "");
}

const DEPLOY_DEFINITION = {
  fields: [
    { name: "name", type: "string", required: true },
    { name: "note", type: "text", required: false },
    {
      name: "region",
      type: "enum",
      required: true,
      values: ["eu", "us"],
    },
    { name: "replicas", type: "number", required: false },
    { name: "hosts", type: "list<string>", required: false },
  ],
  format: "json" as const,
  history: "revision" as const,
  presentation: {
    title: "name",
    summary: "note",
    kind: "configuration" as const,
  },
};

describe("RecordDetailPage content", () => {
  test("content comes first, then tags, metadata and the raw value", async () => {
    server.use(
      recordTypesHandler([
        recordEntry("deploy", 1, { definition: DEPLOY_DEFINITION }),
      ]),
      historyOk(),
      recordWith({
        name: "Production",
        note: "Main region",
        region: "eu",
        hosts: ["a", "b"],
        legacy: true,
      }),
      listOk,
    );
    renderRecord();

    expect(
      await screen.findByRole("dialog", { name: "Production" }),
    ).toBeInTheDocument();
    expect(
      within(region("Summary")).getByText("Main region"),
    ).toBeInTheDocument();
    const fields = await within(region("Fields")).findByRole("table", {
      name: "Record fields",
    });
    // Title and summary fields are not repeated; order is declaration order.
    expect(fieldNames(fields)).toEqual(["region", "replicas", "hosts"]);
    expect(within(fields).getByText("eu")).toHaveAttribute(
      "data-variant",
      "gray",
    );
    expect(within(fields).getByText("Not set")).toBeInTheDocument();
    expect(
      within(region("Other fields")).getByText(
        sentence("Not declared by the deploy schema."),
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Configuration")).toBeInTheDocument();

    const order = [
      "Summary",
      "Fields",
      "Other fields",
      "Tags",
      "Metadata",
      "Value",
    ].map((name) => region(name));
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1].compareDocumentPosition(order[i]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    // The raw value is collapsed until asked for.
    expect(
      within(region("Value")).getByRole("button", {
        name: "Show value (5 keys)",
      }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  test("without a presented title the key is the heading, never Untitled", async () => {
    server.use(
      recordTypesHandler([
        recordEntry("deploy", 1, { definition: DEPLOY_DEFINITION }),
      ]),
      historyOk(),
      recordWith({ region: "us", title: "Not the declared title" }),
      listOk,
    );
    renderRecord();

    // Once the record and its definition are loaded, the heading is the key.
    await screen.findByRole("table", { name: "Record fields" });
    expect(screen.getByRole("dialog", { name: "prod" })).toBeInTheDocument();
    expect(screen.queryByText(/Untitled/)).not.toBeInTheDocument();
  });

  test("an undeclared record type stays readable with all its keys", async () => {
    server.use(
      recordTypesHandler([
        {
          type: "deploy",
          declaration: "undeclared",
          count: 1,
          archived_count: 0,
        },
      ]),
      historyOk(),
      recordWith({ region: "eu", owner: "ops" }),
      listOk,
    );
    renderRecord();

    expect(await screen.findByText("Not in schema")).toHaveAttribute(
      "data-variant",
      "amber",
    );
    const other = await screen.findByRole("region", { name: "Other fields" });
    expect(
      within(other).getByText(
        sentence(
          "Type deploy is not in the current schema. Stored data is shown as-is.",
        ),
      ),
    ).toBeInTheDocument();
    expect(
      fieldNames(within(other).getByRole("table", { name: "Other fields" })),
    ).toEqual(["region", "owner"]);
    expect(
      within(region("Fields")).getByText(
        "No fields are declared for this type.",
      ),
    ).toBeInTheDocument();
  });

  test("Older revisions loads the next history page by cursor", async () => {
    const user = userEvent.setup();
    const cursors: (string | null)[] = [];
    server.use(
      http.get("*/projects/*/records/:type/~/history/*", ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("cursor");
        cursors.push(cursor);
        return cursor === "older"
          ? HttpResponse.json({
              ok: true,
              items: [{ ...historyItem, revision: 1, actor: "first-actor" }],
              meta: { total: 1, limit: 20, next_cursor: null },
            })
          : HttpResponse.json({
              ok: true,
              items: [historyItem],
              meta: { total: 1, limit: 20, next_cursor: "older" },
            });
      }),
      recordOk(),
      listOk,
    );
    renderRecord();

    expect(await screen.findByText("revision-actor")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Older revisions" }));

    expect(await screen.findByText("first-actor")).toBeInTheDocument();
    expect(screen.getByText("revision-actor")).toBeInTheDocument();
    expect(cursors).toEqual([null, "older"]);
    expect(
      screen.queryByRole("button", { name: "Older revisions" }),
    ).not.toBeInTheDocument();
  });
});
