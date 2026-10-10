import { RecordsPage } from "@/pages/records";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse, delay } from "msw";
import { Route, Routes } from "react-router";
import { server } from "../mocks/server";
import { act, renderWithProviders, screen, within } from "../test-utils";

function renderRecords() {
  return renderWithProviders(
    <Routes>
      <Route path="/p/:projectId/records" element={<RecordsPage />} />
    </Routes>,
    { route: "/p/test-project/records" },
  );
}

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
