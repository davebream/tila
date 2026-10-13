import { SELF } from "cloudflare:test";
import {
  type DefinitionDocument,
  type DefinitionImportMode,
  getIn,
  parseSchemaToml,
  planDefinitionImport,
  putField,
  readTomlDefinition,
  setIn,
} from "@tila/core";
import {
  readDefinitionFile,
  renderDefinitionExport,
} from "@tila/core/definition-yaml";
import { canonicalJson } from "@tila/schemas";
import { expect, it } from "vitest";
import { hashToken } from "../../worker/src/lib/hash-token";
import { bindings } from "./setup";

/**
 * #299 acceptance against the real Worker, DO SQLite and D1: import is a plan
 * computed on the client against the revision just read, then the normal
 * revision-checked preview and apply. Export is rendered from GET /schema.
 */

const BOOTSTRAP = `schema_version = 1

[work_units.task]
parents = []
fields = [
  { name = "title", type = "string", required = true },
  { name = "status", type = "enum", values = ["open", "done"] },
]

[work_units.bug]
parents = []
fields = [{ name = "title", type = "string", required = true }]

[artifacts.plan]
mime_types = ["text/markdown"]
retention_days = 30

[templates.bugfix]
description = "A bug and its fix"
[templates.bugfix.entities.bug]
id_suffix = "bug"
type = "bug"

[records.config]
fields = [{ name = "url", type = "string" }]
`;

type Applied = {
  schema: { definition: string; applied_at: number } | null;
  revision: number;
};
type Preview = {
  revision: number;
  reviewed_definition: string;
  changes: Array<{ kind: string }>;
  autoApplicable: boolean;
};

async function project() {
  const projectId = `transfer-${crypto.randomUUID()}`;
  const token = `token-${crypto.randomUUID()}`;
  await bindings.DB.prepare(
    "INSERT INTO _projects (project_id, display_name, created_at, created_by, cloudflare_account_id) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(projectId, projectId, Date.now(), "fixture", "local")
    .run();
  await bindings.DB.prepare(
    "INSERT INTO _tokens (token_hash, project_id, name, scopes, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      await hashToken(token, bindings.HASH_PEPPER),
      projectId,
      "init",
      "full",
      Date.now(),
      "fixture",
    )
    .run();
  const request = (path: string, body?: unknown, key?: string) =>
    SELF.fetch(`https://worker/projects/${projectId}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Tila-Participant-Id": "transfer-test",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const json = async <T>(response: Response): Promise<T> => {
    const body = (await response.json()) as T;
    expect(response.ok, JSON.stringify(body)).toBe(true);
    return body;
  };
  const read = async () => json<Applied>(await request("/schema"));
  const preview = async (definition: string) =>
    json<Preview>(await request("/schema/preview", { definition }));
  const apply = (body: Record<string, unknown>) =>
    request("/schema", body, crypto.randomUUID());

  /** Plan an import against what is applied now, then preview and apply it. */
  async function importDefinition(
    text: string,
    mode: DefinitionImportMode,
    filename = "definitions.toml",
  ) {
    const file = readDefinitionFile(text, { filename });
    if (!file.ok) throw new Error(JSON.stringify(file.errors));
    const current = await read();
    const plan = planDefinitionImport(
      current.schema ? doc(current.schema.definition) : null,
      file.doc,
      mode,
      { projectId, revision: current.revision, metadata: file.metadata },
    );
    if (!plan.ok) throw new Error(JSON.stringify(plan.errors));
    const reviewed = await preview(plan.source);
    expect(reviewed.revision).toBe(current.revision);
    return { plan, reviewed };
  }

  return { projectId, request, read, preview, apply, importDefinition };
}

function doc(source: string): DefinitionDocument {
  const parsed = readTomlDefinition(source);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.doc;
}

function semantic(source: string) {
  const parsed = parseSchemaToml(source);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return canonicalJson(parsed.schema);
}

it("bootstraps, edits, exports and imports to a fresh project with equivalent definitions", async () => {
  const a = await project();

  // Bootstrap from a file: preview against revision 0, then apply.
  const bootstrap = await a.importDefinition(BOOTSTRAP, "merge");
  expect(bootstrap.plan.units.added).toHaveLength(6);
  expect(
    (
      await a.apply({
        definition: bootstrap.plan.source,
        expected_revision: 0,
        reviewed_definition: bootstrap.reviewed.reviewed_definition,
      })
    ).status,
  ).toBe(200);

  // Edit a field and the retention, as the settings forms do.
  const applied = await a.read();
  let edited = doc(applied.schema?.definition ?? "");
  edited = setIn(
    edited,
    ["work_units", "task", "fields"],
    putField(getIn(edited, ["work_units", "task", "fields"]), null, {
      name: "estimate",
      declaration: { type: "string" },
    }),
  );
  edited = setIn(edited, ["artifacts", "plan", "retention_days"], 7);
  const editPlan = planDefinitionImport(
    doc(applied.schema?.definition ?? ""),
    edited,
    "replace",
  );
  if (!editPlan.ok) throw new Error("edit failed");
  const editPreview = await a.preview(editPlan.source);
  expect(
    (
      await a.apply({
        definition: editPlan.source,
        expected_revision: editPreview.revision,
        reviewed_definition: editPreview.reviewed_definition,
        ...(editPreview.autoApplicable ? {} : { strategy: "relax" }),
      })
    ).status,
  ).toBe(200);

  // Export both formats from what is applied now.
  const current = await a.read();
  expect(current.revision).toBe(2);
  const input = {
    source: current.schema?.definition ?? "",
    projectId: a.projectId,
    revision: current.revision,
    appliedAt: current.schema?.applied_at,
  };
  const toml = renderDefinitionExport(input, "toml");
  const yaml = renderDefinitionExport(input, "yaml");
  if (!toml.ok || !yaml.ok) throw new Error("export failed");

  // Import the YAML export into a fresh project.
  const b = await project();
  const imported = await b.importDefinition(yaml.text, "merge", "defs.yaml");
  expect(
    (
      await b.apply({
        definition: imported.plan.source,
        expected_revision: 0,
        reviewed_definition: imported.reviewed.reviewed_definition,
      })
    ).status,
  ).toBe(200);
  const copied = await b.read();
  expect(semantic(copied.schema?.definition ?? "")).toBe(
    semantic(current.schema?.definition ?? ""),
  );
  expect(copied.schema?.definition).not.toContain("tila_export");

  // The TOML export says the same thing.
  const tomlBack = readDefinitionFile(toml.text, { filename: "defs.toml" });
  if (!tomlBack.ok) throw new Error("toml export unreadable");
  expect(tomlBack.metadata?.revision).toBe(2);
  expect(tomlBack.metadata?.project_id).toBe(a.projectId);
});

it("reimporting the original file shows what it reverts and still conflicts on a stale revision", async () => {
  const a = await project();
  const first = await a.importDefinition(BOOTSTRAP, "merge");
  await a.apply({
    definition: first.plan.source,
    expected_revision: 0,
    reviewed_definition: first.reviewed.reviewed_definition,
  });
  // A UI edit lengthens retention.
  const edited = setIn(
    doc((await a.read()).schema?.definition ?? ""),
    ["artifacts", "plan", "retention_days"],
    90,
  );
  const edit = planDefinitionImport(null, edited, "replace");
  if (!edit.ok) throw new Error("edit failed");
  const editPreview = await a.preview(edit.source);
  await a.apply({
    definition: edit.source,
    expected_revision: editPreview.revision,
    reviewed_definition: editPreview.reviewed_definition,
    ...(editPreview.autoApplicable ? {} : { strategy: "relax" }),
  });

  // Reimport the original bootstrap file.
  const reimport = await a.importDefinition(BOOTSTRAP, "merge");
  expect(reimport.plan.units.changed).toEqual(["artifacts.plan"]);
  expect(reimport.reviewed.revision).toBe(2);
  expect(reimport.reviewed.changes.length).toBeGreaterThan(0);

  // Without an expected revision the apply is the legacy path; with one, two
  // concurrent imports at revision 2 conflict.
  const body = {
    definition: reimport.plan.source,
    expected_revision: 2,
    reviewed_definition: reimport.reviewed.reviewed_definition,
    ...(reimport.reviewed.autoApplicable ? {} : { strategy: "relax" }),
  };
  const [one, two] = await Promise.all([a.apply(body), a.apply(body)]);
  expect([one.status, two.status].sort()).toEqual([200, 412]);
  const conflict = [one, two].find((r) => r.status === 412) as Response;
  expect(await conflict.json()).toMatchObject({
    error: { code: "schema-revision-conflict", revision: 3 },
  });
  await [one, two].find((r) => r.status === 200)?.arrayBuffer();
  expect((await a.read()).revision).toBe(3);
});

it("importing one section keeps every other section, task and record", async () => {
  const a = await project();
  const first = await a.importDefinition(BOOTSTRAP, "merge");
  await a.apply({
    definition: first.plan.source,
    expected_revision: 0,
    reviewed_definition: first.reviewed.reviewed_definition,
  });
  expect(
    (
      await a.request("/tasks", {
        id: "task-1",
        type: "task",
        data: { title: "Keep me", status: "open" },
      })
    ).status,
  ).toBe(200);

  const partial = await a.importDefinition(
    '[artifacts.plan]\nmime_types = ["text/markdown"]\nretention_days = 14\n',
    "merge",
  );
  expect(partial.plan.units.removed).toEqual([]);
  expect(partial.plan.units.preserved).toEqual(
    expect.arrayContaining([
      "work_units.task",
      "work_units.bug",
      "templates.bugfix",
      "records.config",
    ]),
  );
  expect(
    (
      await a.apply({
        definition: partial.plan.source,
        expected_revision: 1,
        reviewed_definition: partial.reviewed.reviewed_definition,
        ...(partial.reviewed.autoApplicable ? {} : { strategy: "relax" }),
      })
    ).status,
  ).toBe(200);
  const after = doc((await a.read()).schema?.definition ?? "");
  expect(getIn(after, ["templates", "bugfix"])).toBeDefined();
  expect(getIn(after, ["work_units", "bug"])).toBeDefined();
  expect(getIn(after, ["artifacts", "plan", "retention_days"])).toBe(14);
  expect((await a.request("/tasks/task-1")).status).toBe(200);
});

it("rejects oversize, credential and metadata-bearing definitions without writing", async () => {
  const a = await project();
  const big = JSON.stringify({
    definition: `schema_version = 1\nnote = "${"x".repeat(1_200_000)}"\n`,
    expected_revision: 0,
  });
  const tooLarge = await a.request("/schema", big, "oversize");
  expect(tooLarge.status).toBe(413);
  expect(await tooLarge.json()).toMatchObject({
    error: { code: "payload-too-large" },
  });

  const overDefinition = await a.apply({
    definition: `schema_version = 1\nnote = "${"x".repeat(300_000)}"\n`,
    expected_revision: 0,
  });
  expect(overDefinition.status).toBe(413);
  await overDefinition.arrayBuffer();

  const secret = await a.apply({
    definition: 'schema_version = 1\n[extra]\napi_key = "abc123"\n',
    expected_revision: 0,
  });
  expect(secret.status).toBe(400);
  const body = (await secret.json()) as {
    error: { code: string; errors: { path: string }[] };
  };
  expect(body.error.code).toBe("schema-parse-error");
  expect(body.error.errors[0].path).toBe("extra.api_key");
  expect(JSON.stringify(body)).not.toContain("abc123");

  const metadata = await a.request("/schema/preview", {
    definition:
      'schema_version = 1\n[tila_export]\nformat = "tila-definitions"\nformat_version = 1\n',
  });
  expect(metadata.status).toBe(400);
  await metadata.arrayBuffer();

  expect((await a.read()).revision).toBe(0);
});
