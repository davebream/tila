import type { UnifiedSearchResponse } from "@tila/schemas";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { get, request, resolve, print, output, warn, diagnostic, exit } =
  vi.hoisted(() => ({
    get: vi.fn(),
    request: vi.fn(),
    resolve: vi.fn(),
    print: vi.fn(),
    output: vi.fn(),
    warn: vi.fn(),
    diagnostic: vi.fn(),
    exit: vi.fn(),
  }));
vi.mock("../../context", () => ({
  resolveContext: resolve,
  requireClient: (ctx: { client: unknown }) => ctx.client,
}));
vi.mock("../../lib/output", () => ({
  boundedItems: (items: unknown[]) => items,
  diagnostic,
  exit,
  jsonArg: { json: { type: "boolean" } },
  outputText: output,
  printJson: print,
  warning: warn,
}));
import command from "../../commands/search";
const response: UnifiedSearchResponse = {
  ok: true,
  total: 1,
  next_cursor: "next",
  results: [
    {
      type: "report",
      seq: 7,
      t: 1,
      resource: "project:p",
      principal_id: "p",
      event_name: "pipeline.checked",
      correlation_id: null,
      corrects_seq: 2,
      snippet: "needle",
      indexed_at: 1,
    },
  ],
  scope: {
    kinds: ["report"],
    restricted: false,
    archived: "excluded",
    report_history: {
      archived: "included",
      status: "failed",
      indexed_through_seq: 3,
      target_through_seq: 9,
      error: "journal-history-unavailable",
    },
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  resolve.mockResolvedValue({
    config: { project_id: "p" },
    client: { get, request },
  });
  get.mockResolvedValue(response);
});
afterEach(() => vi.useRealTimers());
async function run(args: object) {
  if (!command.run) throw new Error("Missing search command");
  await command.run({
    args: {
      _: [],
      query: "needle",
      kind: "report",
      cursor: "previous",
      ...args,
    },
  } as never);
}
it("forwards kind and cursor and preserves coverage in JSON", async () => {
  await run({ json: true });
  expect(get).toHaveBeenCalledWith("/projects/p/search", {
    query: { q: "needle", kind: "report", cursor: "previous", limit: "20" },
  });
  expect(print).toHaveBeenCalledWith(response);
});
it("formats report identity and correction and warns about incomplete results", async () => {
  await run({ json: false });
  expect(output).toHaveBeenCalledWith(
    expect.stringContaining("#7  [report] pipeline.checked"),
  );
  expect(output).toHaveBeenCalledWith(expect.stringContaining("corrects #2"));
  expect(output).toHaveBeenCalledWith("Next page: --cursor next");
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("indexing failed"));
});
it("advances local history once and uses paged search", async () => {
  const project = {
    indexReportHistoryBatch: vi.fn(),
    searchPage: vi.fn().mockReturnValue(response),
  };
  resolve.mockResolvedValue({ config: { backend: "local" }, entity: project });
  await run({ json: true });
  expect(project.indexReportHistoryBatch).toHaveBeenCalledOnce();
  expect(project.searchPage).toHaveBeenCalledWith({
    q: "needle",
    limit: 20,
    kinds: ["report"],
    cursor: "previous",
  });
  expect(print).toHaveBeenCalledWith(response);
});

async function reindex() {
  const commands = await command.subCommands;
  if (!commands || typeof commands === "function")
    throw new Error("Missing subcommands");
  const reindex = await commands.reindex;
  if (!reindex || typeof reindex === "function" || !reindex.run)
    throw new Error("Missing reindex command");
  await reindex.run({ args: { _: [], kind: "report" } } as never);
}

it("shows remote report progress and polls report status until complete", async () => {
  vi.useFakeTimers();
  const history = response.scope?.report_history;
  get
    .mockResolvedValueOnce({
      status: "running",
      report_history: { ...history, status: "running" },
    })
    .mockResolvedValueOnce({
      status: "complete",
      report_history: {
        ...history,
        status: "complete",
        indexed_through_seq: 9,
      },
    });
  const pending = reindex();
  await vi.runAllTimersAsync();
  await pending;
  expect(request).toHaveBeenCalledWith("POST", "/projects/p/search/reindex", {
    body: { kind: "report" },
  });
  expect(get).toHaveBeenCalledWith("/projects/p/search/reindex/status", {
    query: { kind: "report" },
  });
  expect(output).toHaveBeenCalledWith(
    "  report: verified through 3 of 9 sequences...",
  );
  expect(output).toHaveBeenCalledWith("Reindex complete for report.");
});

it("drains local report reindex and reports failed history without claiming completion", async () => {
  const project = {
    reindexSearch: vi.fn(),
    reindexReports: vi.fn().mockResolvedValue(response.scope?.report_history),
  };
  resolve.mockResolvedValue({ config: { backend: "local" }, entity: project });
  await reindex();
  expect(project.reindexReports).toHaveBeenCalledOnce();
  expect(project.reindexSearch).not.toHaveBeenCalled();
  expect(diagnostic).toHaveBeenCalledWith(
    "Report indexing failed: journal-history-unavailable",
  );
  expect(exit).toHaveBeenCalledWith(1);
  expect(output).not.toHaveBeenCalledWith(
    expect.stringContaining("Reindex complete"),
  );
});
