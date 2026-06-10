/**
 * Behavioral (handler-invocation) coverage for the tool groups whose
 * surface-parity test only checks registration count/names: journal, schema,
 * signals, summary, templates. Each test invokes the tool HANDLER with
 * representative input and asserts (a) the correct facade.<resource>.<method>
 * was called with the expected TRANSLATED args, and (b) the handler returns the
 * facade result as JSON.
 *
 * journal.query and schema.apply are prioritized: both map onto SDK methods
 * whose Worker route/params were fixed in Task 12, so a wrong arg translation
 * here would be silent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerJournalTools } from "../tools/journal";
import { registerSchemaTools } from "../tools/schema";
import { registerSignalTools } from "../tools/signals";
import { registerSummaryTool } from "../tools/summary";
import { registerTemplateTools } from "../tools/templates";
import {
  type MockFacade,
  type MockServer,
  asFacade,
  asServer,
  createMockFacade,
  createMockServer,
  findToolHandler,
} from "./helpers/mock-facade";

const PROJECT_ID = "test-project";

describe("tool handler invocation — journal", () => {
  let server: MockServer;
  let facade: MockFacade;

  beforeEach(() => {
    server = createMockServer();
    facade = createMockFacade();
    registerJournalTools(asServer(server), asFacade(facade), PROJECT_ID);
  });

  afterEach(() => vi.restoreAllMocks());

  it("tila_journal_list → journal.query with resource/kind/after_seq(stringified)/limit(stringified)", async () => {
    const payload = { ok: true, events: [{ seq: 1 }] };
    facade.journal.query.mockResolvedValue(payload);

    const handler = findToolHandler(server, "tila_journal_list");
    const result = await handler({
      resource: "T-1",
      kind: "entity.update",
      after_seq: 10,
      limit: 50,
    });

    expect(facade.journal.query).toHaveBeenCalledWith({
      resource: "T-1",
      kind: "entity.update",
      after_seq: "10",
      limit: "50",
    });
    expect(JSON.parse(result.content[0].text)).toEqual(payload);
  });

  it("tila_journal_list passes after_seq undefined when omitted, limit defaulted to '20'", async () => {
    facade.journal.query.mockResolvedValue({ ok: true, events: [] });

    const handler = findToolHandler(server, "tila_journal_list");
    await handler({ limit: 20 });

    expect(facade.journal.query).toHaveBeenCalledWith({
      resource: undefined,
      kind: undefined,
      after_seq: undefined,
      limit: "20",
    });
  });
});

describe("tool handler invocation — schema", () => {
  let server: MockServer;
  let facade: MockFacade;

  beforeEach(() => {
    server = createMockServer();
    facade = createMockFacade();
    registerSchemaTools(asServer(server), asFacade(facade), PROJECT_ID);
  });

  afterEach(() => vi.restoreAllMocks());

  it("tila_schema_update → schema.apply(definition, strategy)", async () => {
    const payload = { ok: true, version: 2, diff: {} };
    facade.schema.apply.mockResolvedValue(payload);

    const handler = findToolHandler(server, "tila_schema_update");
    const result = await handler({
      definition: "schema_version = 1\n",
      strategy: "relax",
    });

    expect(facade.schema.apply).toHaveBeenCalledWith(
      "schema_version = 1\n",
      "relax",
    );
    expect(JSON.parse(result.content[0].text)).toEqual(payload);
  });

  it("tila_schema_update passes strategy undefined when omitted", async () => {
    facade.schema.apply.mockResolvedValue({ ok: true, version: 1, diff: {} });

    const handler = findToolHandler(server, "tila_schema_update");
    await handler({ definition: "schema_version = 1\n" });

    expect(facade.schema.apply).toHaveBeenCalledWith(
      "schema_version = 1\n",
      undefined,
    );
  });
});

describe("tool handler invocation — signals", () => {
  let server: MockServer;
  let facade: MockFacade;

  beforeEach(() => {
    server = createMockServer();
    facade = createMockFacade();
    registerSignalTools(asServer(server), asFacade(facade), PROJECT_ID);
  });

  afterEach(() => vi.restoreAllMocks());

  it("tila_signal_send → signals.send with the full request object", async () => {
    const payload = { ok: true, id: "sig-1" };
    facade.signals.send.mockResolvedValue(payload);

    const handler = findToolHandler(server, "tila_signal_send");
    const result = await handler({
      target: "agent-2",
      kind: "assignment",
      resource: "T-1",
      payload: { note: "go" },
      ttl_ms: 60000,
    });

    expect(facade.signals.send).toHaveBeenCalledWith({
      target: "agent-2",
      kind: "assignment",
      resource: "T-1",
      payload: { note: "go" },
      ttl_ms: 60000,
    });
    expect(JSON.parse(result.content[0].text)).toEqual(payload);
  });

  it("tila_signal_list → signals.inbox()", async () => {
    const payload = { ok: true, signals: [] };
    facade.signals.inbox.mockResolvedValue(payload);

    const handler = findToolHandler(server, "tila_signal_list");
    const result = await handler({});

    expect(facade.signals.inbox).toHaveBeenCalledWith();
    expect(JSON.parse(result.content[0].text)).toEqual(payload);
  });

  it("tila_signal_ack → signals.ack(id)", async () => {
    facade.signals.ack.mockResolvedValue({ ok: true });

    const handler = findToolHandler(server, "tila_signal_ack");
    await handler({ id: "sig-9" });

    expect(facade.signals.ack).toHaveBeenCalledWith("sig-9");
  });
});

describe("tool handler invocation — summary", () => {
  let server: MockServer;
  let facade: MockFacade;

  beforeEach(() => {
    server = createMockServer();
    facade = createMockFacade();
    registerSummaryTool(asServer(server), asFacade(facade), PROJECT_ID);
  });

  afterEach(() => vi.restoreAllMocks());

  it("tila_summary → summary.get() and returns the result", async () => {
    const payload = { ok: true, project: { entity_count: 3 } };
    facade.summary.get.mockResolvedValue(payload);

    const handler = findToolHandler(server, "tila_summary");
    const result = await handler({});

    expect(facade.summary.get).toHaveBeenCalledWith();
    expect(JSON.parse(result.content[0].text)).toEqual(payload);
  });
});

describe("tool handler invocation — templates", () => {
  let server: MockServer;
  let facade: MockFacade;

  beforeEach(() => {
    server = createMockServer();
    facade = createMockFacade();
    registerTemplateTools(asServer(server), asFacade(facade), PROJECT_ID);
  });

  afterEach(() => vi.restoreAllMocks());

  it("tila_template_list → templates.list()", async () => {
    const payload = { ok: true, templates: [] };
    facade.templates.list.mockResolvedValue(payload);

    const handler = findToolHandler(server, "tila_template_list");
    const result = await handler({});

    expect(facade.templates.list).toHaveBeenCalledWith();
    expect(JSON.parse(result.content[0].text)).toEqual(payload);
  });

  it("tila_template_instantiate → templates.instantiate with translated {template_name, root_id, vars}", async () => {
    const payload = {
      ok: true,
      created_entities: ["T-1"],
      created_relationships: [],
      journal_seq: 1,
    };
    facade.templates.instantiate.mockResolvedValue(payload);

    const handler = findToolHandler(server, "tila_template_instantiate");
    const result = await handler({
      template: "epic",
      id: "E-1",
      variables: { title: "Ship it" },
    });

    expect(facade.templates.instantiate).toHaveBeenCalledWith({
      template_name: "epic",
      root_id: "E-1",
      vars: { title: "Ship it" },
    });
    expect(JSON.parse(result.content[0].text)).toEqual(payload);
  });

  it("tila_template_instantiate auto-generates root_id when id is omitted", async () => {
    facade.templates.instantiate.mockResolvedValue({
      ok: true,
      created_entities: [],
      created_relationships: [],
      journal_seq: 0,
    });

    const handler = findToolHandler(server, "tila_template_instantiate");
    await handler({ template: "epic", variables: {} });

    const arg = facade.templates.instantiate.mock.calls[0][0] as {
      template_name: string;
      root_id: string;
      vars: Record<string, unknown>;
    };
    expect(arg.template_name).toBe("epic");
    expect(typeof arg.root_id).toBe("string");
    expect(arg.root_id.length).toBeGreaterThan(0);
    expect(arg.vars).toEqual({});
  });
});
