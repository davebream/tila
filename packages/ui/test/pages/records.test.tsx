import { RecordsPage } from "@/pages/records";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse, delay } from "msw";
import {
  type Location,
  type NavigateFunction,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router";
import {
  makeRecordItem,
  manyRecords,
  pagedRecordsHandler,
  recordEntry,
  recordTypesHandler,
} from "../mocks/records";
import { server } from "../mocks/server";
import {
  act,
  renderWithProviders,
  screen,
  waitFor,
  within,
} from "../test-utils";

let currentLocation: Location;
let navigateTo: NavigateFunction;

function LocationProbe() {
  currentLocation = useLocation();
  navigateTo = useNavigate();
  return null;
}

function renderRecords(route = "/p/test-project/records") {
  return renderWithProviders(
    <Routes>
      <Route
        path="/p/:projectId/records"
        element={
          <>
            <RecordsPage />
            <LocationProbe />
          </>
        }
      />
    </Routes>,
    { route },
  );
}

const urlParam = (name: string) =>
  new URLSearchParams(currentLocation.search).get(name);

function typesHandler(body: object) {
  return http.get("*/projects/*/records/_types", () =>
    HttpResponse.json({ ok: true, ...body }),
  );
}

const typesFailure = (status: number, code: string) => () =>
  HttpResponse.json(
    {
      ok: false,
      error: { code, message: "Types failed", retryable: status >= 500 },
    },
    { status },
  );

// The per-type list the page loads for the selected tab.
const emptyList = http.get("*/projects/*/records/:type", () =>
  HttpResponse.json({
    ok: true,
    items: [],
    meta: { total: 0, limit: 200, next_cursor: null },
  }),
);

// "Loading types…" is also an <output>, so wait for the incompleteness notice by its text.
async function incompleteNotice() {
  const text = await screen.findByText(/Some record types may be missing/);
  const notice = text.closest("output");
  if (!notice) throw new Error("notice is not an <output>");
  return notice;
}

describe("RecordsPage record types", () => {
  test("a complete listing shows the types and no incompleteness notice", async () => {
    server.use(
      typesHandler({
        types: ["deploy", "flags"],
        declared_types: ["deploy", "flags"],
        in_use_types: ["deploy"],
      }),
      emptyList,
    );
    renderRecords();

    const tabs = await screen.findByRole("tablist", { name: "Record types" });
    expect(within(tabs).getAllByRole("tab")).toHaveLength(2);
    expect(screen.queryByText(/may be missing/)).not.toBeInTheDocument();
  });

  test("a project with no types says so", async () => {
    server.use(
      typesHandler({ types: [], declared_types: [], in_use_types: [] }),
    );
    renderRecords();

    expect(
      await screen.findByText("No record types defined."),
    ).toBeInTheDocument();
  });

  test("an unreadable schema with no other types never claims none are defined", async () => {
    const user = userEvent.setup();
    server.use(
      typesHandler({
        types: [],
        declared_types: [],
        in_use_types: [],
        incomplete: { declared_types: "unavailable" },
      }),
    );
    renderRecords();

    const notice = await incompleteNotice();
    expect(notice).toHaveTextContent(
      "Some record types may be missing: the schema could not be read.",
    );
    expect(
      screen.queryByText("No record types defined."),
    ).not.toBeInTheDocument();

    server.use(
      typesHandler({
        types: ["deploy"],
        declared_types: ["deploy"],
        in_use_types: [],
      }),
      emptyList,
    );
    await user.click(within(notice).getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("tab", { name: "deploy" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/may be missing/)).not.toBeInTheDocument();
  });

  test("a partial listing keeps the types it has and says what is missing", async () => {
    server.use(
      typesHandler({
        types: ["deploy"],
        declared_types: ["deploy"],
        in_use_types: [],
        incomplete: { in_use_types: "unavailable" },
      }),
      emptyList,
    );
    renderRecords();

    expect(
      await screen.findByRole("tab", { name: "deploy" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Some record types may be missing: types in use could not be listed.",
    );
  });

  test("an invalid schema is reported without a retry that cannot help", async () => {
    server.use(
      typesHandler({
        types: ["deploy"],
        declared_types: [],
        in_use_types: ["deploy"],
        incomplete: { declared_types: "invalid" },
      }),
      emptyList,
    );
    renderRecords();

    const notice = await incompleteNotice();
    expect(notice).toHaveTextContent(
      "Some record types may be missing: the schema is invalid.",
    );
    expect(
      within(notice).queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
  });

  test("both reasons are listed together", async () => {
    server.use(
      typesHandler({
        types: [],
        declared_types: [],
        in_use_types: [],
        incomplete: { declared_types: "invalid", in_use_types: "unavailable" },
      }),
    );
    renderRecords();

    expect(await incompleteNotice()).toHaveTextContent(
      "the schema is invalid; types in use could not be listed.",
    );
  });

  test("a failed types request shows the error code and a retry, not 'no types'", async () => {
    server.use(
      http.get(
        "*/projects/*/records/_types",
        typesFailure(503, "do-unreachable"),
      ),
    );
    renderRecords();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load record types.");
    expect(alert).toHaveTextContent("do-unreachable");
    expect(
      within(alert).getByRole("button", { name: "Retry" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No record types defined."),
    ).not.toBeInTheDocument();
  });

  test("a forbidden types request is access denied, not empty", async () => {
    server.use(
      http.get(
        "*/projects/*/records/_types",
        typesFailure(403, "permission-denied"),
      ),
    );
    renderRecords();

    expect(
      await screen.findByText("You do not have access to record types."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No record types defined."),
    ).not.toBeInTheDocument();
  });

  test("pending types show loading text, not 'no types'", async () => {
    server.use(
      http.get("*/projects/*/records/_types", async () => {
        await delay("infinite");
      }),
    );
    renderRecords();

    expect(await screen.findByText("Loading types…")).toBeInTheDocument();
    expect(
      screen.queryByText("No record types defined."),
    ).not.toBeInTheDocument();
  });

  test("a failed refresh keeps the tabs with a stale notice", async () => {
    server.use(
      typesHandler({
        types: ["deploy"],
        declared_types: ["deploy"],
        in_use_types: [],
      }),
      emptyList,
    );
    const { queryClient } = renderRecords();
    await screen.findByRole("tab", { name: "deploy" });

    server.use(
      http.get(
        "*/projects/*/records/_types",
        typesFailure(503, "do-unreachable"),
      ),
    );
    await act(() =>
      queryClient.invalidateQueries({ queryKey: ["recordTypes"] }),
    );

    expect(
      await screen.findByText(/Showing record types from .* Refresh failed/),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "deploy" })).toBeInTheDocument();
  });
});

describe("RecordsPage catalog tabs", () => {
  test("declared types come first with counts, including empty ones", async () => {
    server.use(
      recordTypesHandler([
        recordEntry("deploy", 2),
        recordEntry("flags", 0),
        {
          type: "legacy",
          declaration: "undeclared",
          count: 1,
          archived_count: 0,
        },
      ]),
      pagedRecordsHandler([]),
    );
    renderRecords("/p/test-project/records?type=flags");

    const tabs = await screen.findByRole("tablist", { name: "Record types" });
    const names = within(tabs)
      .getAllByRole("tab")
      .map((t) => t.textContent);
    expect(names).toEqual(["deploy2", "flags0", "legacy1Not in schema"]);
    const legacy = within(tabs).getByRole("tab", { name: /legacy/ });
    expect(within(legacy).getByText("Not in schema")).toHaveAttribute(
      "data-variant",
      "amber",
    );
    expect(
      await screen.findByText(
        (_, el) =>
          el?.tagName === "P" && el.textContent === "No flags records.",
      ),
    ).toBeInTheDocument();
  });

  test("with no type in the URL the first entry is opened", async () => {
    server.use(
      recordTypesHandler([recordEntry("alpha", 0), recordEntry("beta", 1)]),
      pagedRecordsHandler([]),
    );
    renderRecords();

    await waitFor(() => expect(urlParam("type")).toBe("alpha"));
    expect(screen.getByRole("tab", { name: /alpha/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  test("a classification badge appears only when the definition declares it", async () => {
    server.use(
      recordTypesHandler([
        // Named like configuration, but makes no claim: no badge.
        recordEntry("config", 1),
        recordEntry("settings", 1, {
          definition: {
            fields: [],
            format: "json",
            history: "revision",
            presentation: { kind: "configuration" },
          },
        }),
        recordEntry("pages", 1, {
          definition: {
            fields: [],
            format: "json",
            history: "revision",
            presentation: { kind: "content" },
          },
        }),
      ]),
      pagedRecordsHandler([]),
    );
    renderRecords("/p/test-project/records?type=config");

    const config = await screen.findByRole("tab", { name: /^config/ });
    expect(within(config).queryByText("Configuration")).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("tab", { name: /settings/ })).getByText(
        "Configuration",
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("tab", { name: /pages/ })).getByText("Content"),
    ).toBeInTheDocument();
  });

  test("an unknown type in the URL is reported, not replaced", async () => {
    const listed: string[] = [];
    server.use(
      recordTypesHandler([recordEntry("deploy", 1)]),
      pagedRecordsHandler([makeRecordItem("deploy", "prod")], {
        onRequest: (type) => listed.push(type),
      }),
    );
    renderRecords("/p/test-project/records?type=ghost");

    expect(
      await screen.findByText(
        (_, el) =>
          el?.tagName === "SPAN" &&
          el.textContent === "ghost is not an available record type.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /deploy/ })).toBeInTheDocument();
    expect(urlParam("type")).toBe("ghost");
    expect(listed).not.toContain("ghost");
  });
});

describe("RecordsPage list", () => {
  function captureRequests(items = manyRecords("deploy", 150)) {
    const requests: URLSearchParams[] = [];
    server.use(
      recordTypesHandler([recordEntry("deploy", items.length)]),
      pagedRecordsHandler(items, { onRequest: (_, p) => requests.push(p) }),
    );
    return requests;
  }

  test("Next and Previous walk cursor pages with the cursor in the URL", async () => {
    const user = userEvent.setup();
    const requests = captureRequests();
    renderRecords("/p/test-project/records?type=deploy");

    expect(await screen.findByText("key-001")).toBeInTheDocument();
    expect(screen.getByText("1–100 of 150")).toBeInTheDocument();
    expect(requests.at(-1)?.get("limit")).toBe("100");

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("key-101")).toBeInTheDocument();
    expect(screen.getByText("101–150 of 150")).toBeInTheDocument();
    expect(urlParam("after")).not.toBeNull();
    expect(requests.at(-1)?.get("cursor")).toBe(urlParam("after"));

    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByText("key-001")).toBeInTheDocument();
    expect(urlParam("after")).toBeNull();

    // Browser Back returns to the second page.
    act(() => navigateTo(-1));
    expect(await screen.findByText("key-101")).toBeInTheDocument();
  });

  test("the key filter is sent to the server and drops the cursor", async () => {
    const user = userEvent.setup();
    const requests = captureRequests();
    renderRecords("/p/test-project/records?type=deploy");
    await screen.findByText("key-001");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("key-101");

    await user.type(screen.getByLabelText("Filter records by key"), "-12");

    await waitFor(() => expect(urlParam("q")).toBe("-12"));
    expect(urlParam("after")).toBeNull();
    // The URL updates before the debounced request is sent; wait for it.
    await waitFor(() =>
      expect(requests.at(-1)?.get("key_contains")).toBe("-12"),
    );
    expect(requests.at(-1)?.has("cursor")).toBe(false);
    expect(await screen.findByText("key-120")).toBeInTheDocument();
    expect(screen.queryByText("key-101")).not.toBeInTheDocument();
  });

  test("sorting is done by the server", async () => {
    const user = userEvent.setup();
    const requests = captureRequests(manyRecords("deploy", 3));
    renderRecords("/p/test-project/records?type=deploy");
    await screen.findByText("key-001");
    expect(requests.at(-1)?.get("sort")).toBe("key");
    expect(requests.at(-1)?.get("order")).toBe("asc");

    await user.click(screen.getByRole("columnheader", { name: /Revision/ }));

    await waitFor(() => expect(requests.at(-1)?.get("sort")).toBe("revision"));
    expect(requests.at(-1)?.get("order")).toBe("desc");
    expect(urlParam("sort")).toBe("revision:desc");
    const rows = screen
      .getAllByRole("row")
      .filter((r) => r.getAttribute("aria-rowindex"));
    expect(within(rows[0]).getByText("key-003")).toBeInTheDocument();
  });

  test("an invalid cursor resets to the first page with a notice", async () => {
    captureRequests();
    renderRecords("/p/test-project/records?type=deploy&after=bogus");

    expect(
      await screen.findByText(
        "That page link is no longer valid; showing the first page.",
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText("key-001")).toBeInTheDocument();
    expect(urlParam("after")).toBeNull();
  });

  test("states the restricted scope of the count", async () => {
    server.use(
      recordTypesHandler([recordEntry("deploy", 2)], { restricted: true }),
      pagedRecordsHandler(manyRecords("deploy", 2), { restricted: true }),
    );
    renderRecords("/p/test-project/records?type=deploy");

    expect(
      await screen.findByText(
        "2 records · excluding archived · visible to this credential",
      ),
    ).toBeInTheDocument();
  });

  test("including archived is sent and stated", async () => {
    const user = userEvent.setup();
    const requests = captureRequests(manyRecords("deploy", 2));
    renderRecords("/p/test-project/records?type=deploy");
    expect(
      await screen.findByText("2 records · excluding archived"),
    ).toBeInTheDocument();
    expect(requests.at(-1)?.has("include-archived")).toBe(false);

    await user.click(
      screen.getByRole("checkbox", { name: "Include archived" }),
    );

    expect(
      await screen.findByText("2 records · including archived"),
    ).toBeInTheDocument();
    expect(requests.at(-1)?.get("include-archived")).toBe("true");
  });

  test("a declared presentation title adds a Title column", async () => {
    server.use(
      recordTypesHandler([
        recordEntry("deploy", 2, {
          definition: {
            fields: [{ name: "name", type: "string", required: false }],
            format: "json",
            history: "revision",
            presentation: { title: "name" },
          },
        }),
        recordEntry("flags", 1),
      ]),
      pagedRecordsHandler([
        makeRecordItem("deploy", "prod", { title: "Production" }),
        makeRecordItem("deploy", "scratch", { title: null }),
        makeRecordItem("flags", "beta"),
      ]),
    );
    renderRecords("/p/test-project/records?type=deploy");

    expect(await screen.findByText("Production")).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Title" }),
    ).toBeInTheDocument();
    const scratch = screen.getByText("scratch").closest("tr") as HTMLElement;
    expect(within(scratch).getAllByRole("cell")[1]).toHaveTextContent(/^—$/);
    expect(screen.queryByText(/Untitled/)).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("tab", { name: /flags/ }));
    expect(await screen.findByText("beta")).toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: "Title" }),
    ).not.toBeInTheDocument();
  });
});
