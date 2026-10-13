import { RecordCreateDrawer } from "@/components/work/record-editor";
import { RecordDetailPage } from "@/pages/record-detail";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router";
import { recordEntry, recordTypesHandler } from "../mocks/records";
import { server } from "../mocks/server";
import { renderWithProviders, screen, waitFor } from "../test-utils";

const deploy = recordEntry("deploy", 1, {
  definition: {
    fields: [
      { name: "region", type: "string", required: true },
      { name: "replicas", type: "number", required: false, default: 2 },
    ],
    format: "json",
    history: "revision",
  },
});

let stored = {
  type: "deploy",
  key: "prod",
  schema_version: 1,
  value: { region: "eu", replicas: 3, owner: "ops" } as Record<string, unknown>,
  value_sha256: "a".repeat(64),
  revision: 3,
  archived: 0,
  created_at: 1,
  updated_at: 2,
  updated_by: "alice",
  tags: [],
};
let fence = 7;

beforeEach(() => {
  window.sessionStorage.clear();
  fence = 7;
  stored = { ...stored, value: { region: "eu", replicas: 3, owner: "ops" } };
  server.use(
    recordTypesHandler([
      deploy,
      recordEntry("legacy", 1, {
        declaration: "undeclared",
        definition: undefined,
      }),
    ]),
    http.get("*/api/whoami", () =>
      HttpResponse.json({
        ok: true,
        project_id: "test-project",
        token_name: "dev",
        scopes: "write",
        role: "participant",
        principal_id: "github:example:1",
      }),
    ),
    http.get("*/projects/*/records/:type/~/history/*", () =>
      HttpResponse.json({
        ok: true,
        items: [],
        meta: { total: 0, limit: 20, next_cursor: null },
      }),
    ),
    http.get("*/projects/*/records/:type/*", () =>
      HttpResponse.json({ ok: true, record: stored, fence }),
    ),
    http.get("*/projects/*/records/:type", () =>
      HttpResponse.json({
        ok: true,
        items: [],
        meta: { total: 0, limit: 50, next_cursor: null },
      }),
    ),
  );
});

test("creates a declared record with defaults prefilled", async () => {
  const user = userEvent.setup();
  let body: unknown;
  server.use(
    http.post("*/projects/test-project/records/deploy", async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ ok: true, record: stored, fence: 1 });
    }),
  );
  renderWithProviders(
    <Routes>
      <Route path="/p/:projectId/records" element={<RecordCreateDrawer />} />
      <Route path="/p/:projectId/records/:type/*" element={<p>Opened</p>} />
    </Routes>,
    { route: "/p/test-project/records?type=deploy&create=record" },
  );
  await user.type(
    await screen.findByRole("textbox", { name: /key/i }),
    "staging",
  );
  expect(screen.getByRole("spinbutton", { name: /replicas/i })).toHaveValue(2);
  await user.type(screen.getByRole("textbox", { name: /region/i }), "us");
  await user.click(screen.getByRole("button", { name: "Create record" }));
  await screen.findByText("Opened");
  expect(body).toEqual({
    key: "staging",
    value: { region: "us", replicas: 2 },
  });
});

function renderDetail(key = "prod", type = "deploy") {
  return renderWithProviders(
    <Routes>
      <Route
        path="/p/:projectId/records/:type/*"
        element={<RecordDetailPage />}
      />
    </Routes>,
    { route: `/p/test-project/records/${type}/${key}` },
  );
}

test("edits at the loaded fence and keeps undeclared keys", async () => {
  const user = userEvent.setup();
  let body: unknown;
  server.use(
    http.put(
      "*/projects/test-project/records/deploy/prod",
      async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ok: true, record: stored, fence: 8 });
      },
    ),
  );
  renderDetail();
  await user.click(await screen.findByRole("button", { name: "Edit" }));
  const replicas = screen.getByRole("spinbutton", { name: /replicas/i });
  await user.clear(replicas);
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(body).toEqual({ value: { owner: "ops", region: "eu" }, fence: 7 }),
  );
});

test("a stale fence keeps the draft and requires review before saving again", async () => {
  const user = userEvent.setup();
  server.use(
    http.put("*/projects/test-project/records/deploy/prod", () => {
      fence = 9; // Someone else wrote first.
      return HttpResponse.json(
        { ok: false, error: { code: "stale-fence", message: "Stale fence" } },
        { status: 409 },
      );
    }),
  );
  const view = renderDetail();
  await user.click(await screen.findByRole("button", { name: "Edit" }));
  const region = screen.getByRole("textbox", { name: /region/i });
  await user.clear(region);
  await user.type(region, "apac");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(
    await screen.findByText(/changed since you started editing/i),
  ).toBeInTheDocument();
  await view.queryClient.invalidateQueries();
  expect(
    await screen.findByRole("button", {
      name: "Keep my draft on the latest version",
    }),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(screen.getByRole("textbox", { name: /region/i })).toHaveValue("apac");
});

test("undeclared record types are read-only", async () => {
  renderDetail("x", "legacy");
  expect(await screen.findByRole("button", { name: "Edit" })).toBeDisabled();
  expect(screen.getByText(/records are read-only here/)).toBeInTheDocument();
});
