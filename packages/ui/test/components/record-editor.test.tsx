import { NewRecordLink } from "@/components/work/create-links";
import { RecordCreateDrawer } from "@/components/work/record-editor";
import { RecordDetailPage } from "@/pages/record-detail";
import userEvent from "@testing-library/user-event";
import type { WhoamiResponse } from "@tila/schemas";
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

// -- Side-specific record rights ---------------------------------------------

type Restrictions = NonNullable<
  NonNullable<WhoamiResponse["policy"]>["restrictions"]
>;

function identifyAs(
  restrictions: Restrictions | undefined,
  options: { role?: "viewer" | "participant"; capabilities?: string[] } = {},
) {
  const role = options.role ?? "participant";
  server.use(
    http.get("*/api/whoami", () =>
      HttpResponse.json({
        ok: true,
        project_id: "test-project",
        token_name: "dev",
        scopes: role === "viewer" ? "read" : "write",
        role,
        principal_id: "github:example:1",
        policy: {
          role,
          capabilities: options.capabilities ?? [
            "records:read",
            "records:write",
          ],
          ...(restrictions ? { restrictions } : {}),
        },
      }),
    ),
  );
}

function renderCreate(type = "deploy") {
  return renderWithProviders(
    <Routes>
      <Route path="/p/:projectId/records" element={<RecordCreateDrawer />} />
      <Route path="/p/:projectId/records/:type/*" element={<p>Opened</p>} />
    </Routes>,
    { route: `/p/test-project/records?type=${type}&create=record` },
  );
}

describe("creating a record with a split restriction", () => {
  const split: Restrictions = {
    records_read: [{ type: "deploy", key_prefixes: ["pub"] }],
    records_write: [{ type: "deploy", key_prefixes: ["inbox"] }],
  };

  it("stays on the list when the credential may write the key but not read it", async () => {
    const user = userEvent.setup();
    identifyAs(split);
    let body: unknown;
    server.use(
      http.post(
        "*/projects/test-project/records/deploy",
        async ({ request }) => {
          body = await request.json();
          // What a write-only credential is answered with.
          return HttpResponse.json({
            ok: true,
            receipt: true,
            type: "deploy",
            key: "inbox/a",
            fence: 1,
          });
        },
      ),
    );
    renderCreate();
    await user.type(
      await screen.findByRole("textbox", { name: /key/i }),
      "inbox/a",
    );
    await user.type(screen.getByRole("textbox", { name: /region/i }), "us");
    await user.click(screen.getByRole("button", { name: "Create record" }));

    expect(
      await screen.findByText(/may write it but not read it/),
    ).toBeVisible();
    expect(screen.queryByText("Opened")).not.toBeInTheDocument();
    expect(body).toEqual({
      key: "inbox/a",
      value: { region: "us", replicas: 2 },
    });
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create record" }),
    ).not.toBeInTheDocument();
  });

  it("opens the record when the credential may read the key it wrote", async () => {
    const user = userEvent.setup();
    identifyAs({
      records_read: [{ type: "deploy" }],
      records_write: [{ type: "deploy", key_prefixes: ["inbox"] }],
    });
    server.use(
      http.post("*/projects/test-project/records/deploy", () =>
        HttpResponse.json({ ok: true, record: stored, fence: 1 }),
      ),
    );
    renderCreate();
    await user.type(
      await screen.findByRole("textbox", { name: /key/i }),
      "inbox/a",
    );
    await user.type(screen.getByRole("textbox", { name: /region/i }), "us");
    await user.click(screen.getByRole("button", { name: "Create record" }));
    await screen.findByText("Opened");
  });

  it("refuses a key only the read side admits, before sending anything", async () => {
    const user = userEvent.setup();
    identifyAs(split);
    let sent = false;
    server.use(
      http.post("*/projects/test-project/records/deploy", () => {
        sent = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    renderCreate();
    await user.type(
      await screen.findByRole("textbox", { name: /key/i }),
      "pub/a",
    );
    await user.type(screen.getByRole("textbox", { name: /region/i }), "us");
    await user.click(screen.getByRole("button", { name: "Create record" }));
    expect(
      await screen.findByText("This credential cannot write that key."),
    ).toBeInTheDocument();
    expect(sent).toBe(false);
  });

  it("offers no create to a read-only credential", async () => {
    identifyAs({ records_read: [{ type: "deploy" }] });
    renderCreate();
    expect(
      await screen.findByText(/cannot write records of type/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create record" }),
    ).toBeDisabled();
  });

  it("explains a type the credential may write but cannot see", async () => {
    // The catalog lists only what a credential may read.
    identifyAs({ records_write: [{ type: "ghost" }] });
    renderCreate("ghost");
    expect(
      await screen.findByText(/may write records of type.*cannot see its/s),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/not declared by the current schema/),
    ).not.toBeInTheDocument();
  });

  it("keeps the old message for a type nobody may write", async () => {
    identifyAs({ records_write: [{ type: "deploy" }] });
    renderCreate("ghost");
    expect(
      await screen.findByText(/not declared\s+by the current schema/),
    ).toBeInTheDocument();
  });
});

describe("the New record link", () => {
  function renderLink(type = "deploy") {
    return renderWithProviders(
      <Routes>
        <Route
          path="/p/:projectId/records"
          element={<NewRecordLink type={type} declared />}
        />
      </Routes>,
      { route: `/p/test-project/records?type=${type}` },
    );
  }

  it.each<[string, Restrictions | undefined, boolean]>([
    ["an unrestricted credential", undefined, true],
    ["a legacy list for the type", { records: [{ type: "deploy" }] }, true],
    [
      "a legacy prefix for the type",
      { records: [{ type: "deploy", key_prefixes: ["a"] }] },
      true,
    ],
    ["a legacy list for another type", { records: [{ type: "other" }] }, false],
    [
      "a legacy rule with no keys",
      { records: [{ type: "deploy", key_prefixes: [] }] },
      false,
    ],
    [
      "a write-only split credential",
      { records_write: [{ type: "deploy" }] },
      true,
    ],
    [
      "a write-only split credential with a prefix",
      { records_write: [{ type: "deploy", key_prefixes: ["inbox"] }] },
      true,
    ],
    [
      "a read-only split credential",
      { records_read: [{ type: "deploy" }] },
      false,
    ],
    [
      "a split credential that writes another type",
      {
        records_read: [{ type: "deploy" }],
        records_write: [{ type: "other" }],
      },
      false,
    ],
    [
      "a split credential with an empty write side",
      { records_read: [{ type: "deploy" }], records_write: [] },
      false,
    ],
  ])("%s", async (_name, restrictions, shown) => {
    identifyAs(restrictions);
    renderLink();
    if (shown)
      expect(
        await screen.findByRole("link", { name: /New record/ }),
      ).toBeInTheDocument();
    else {
      // Let the identity load, then check the link never appeared.
      await waitFor(() =>
        expect(
          screen.queryByRole("link", { name: /New record/ }),
        ).not.toBeInTheDocument(),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        screen.queryByRole("link", { name: /New record/ }),
      ).not.toBeInTheDocument();
    }
  });

  it("is not offered to a viewer", async () => {
    identifyAs(undefined, { role: "viewer", capabilities: ["records:read"] });
    renderLink();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      screen.queryByRole("link", { name: /New record/ }),
    ).not.toBeInTheDocument();
  });
});
