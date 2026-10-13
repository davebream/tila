import { SELF } from "cloudflare:test";
import {
  type DefinitionDocument,
  getIn,
  parseDefinitionDocument,
  rebaseDefinition,
  serializeDefinitionDocument,
  setIn,
} from "@tila/core";
import { expect, it } from "vitest";
import { bindings } from "./setup";

/**
 * The dashboard's definition editor against the real Worker, DO SQLite and D1:
 * a cookie session (Origin + participant headers, as a browser sends them)
 * drives the same core document helpers the editor uses.
 */
const origin = "https://worker";
const project = "editor-project";
const password = "test-password-long-enough";

function call(
  path: string,
  options: { body?: unknown; credential?: string; key?: string } = {},
) {
  const { body, credential, key } = options;
  return SELF.fetch(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Tila-Participant-Id": "dashboard-runtime-test",
      "X-Tila-Client-Name": "dashboard",
      ...(key ? { "Idempotency-Key": key } : {}),
      ...(credential?.startsWith("Bearer ")
        ? { Authorization: credential }
        : credential
          ? { Cookie: credential }
          : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function ok<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T;
  expect(response.ok, JSON.stringify(body)).toBe(true);
  return body;
}

async function ownerSession() {
  await bindings.DB.prepare(
    `INSERT INTO _projects (project_id,created_at,created_by,cloudflare_account_id) VALUES ('${project}',0,'fixture','local')`,
  ).run();
  const invitation = await ok<{ url: string }>(
    await call("/api/account/setup", {
      body: { email: "owner@example.com", projectId: project },
      credential: "Bearer runtime-test-infra-owner",
    }),
  );
  await ok(
    await call("/api/account/invitations/accept", {
      body: {
        token: new URL(invitation.url).hash.slice(1),
        name: "Owner",
        password,
      },
    }),
  );
  const login = await call("/api/account/auth/sign-in/email", {
    body: { email: "owner@example.com", password },
  });
  await ok(login);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  await ok(
    await call("/api/workspace/select", {
      body: { project_id: project },
      credential: cookie,
    }),
  );
  return cookie;
}

type Applied = {
  schema: { definition: string } | null;
  revision: number;
};
type Preview = {
  revision: number;
  reviewed_definition: string;
  changes: Array<Record<string, unknown>>;
  autoApplicable: boolean;
};

function doc(source: string): DefinitionDocument {
  const parsed = parseDefinitionDocument(source);
  if (!parsed.ok) throw new Error(parsed.errors[0].message);
  return parsed.doc;
}

it("initializes, edits, conflicts, rebases and restores definitions from a browser session", async () => {
  const cookie = await ownerSession();
  const schema = `/projects/${project}/schema`;
  const read = async () =>
    ok<Applied>(await call(schema, { credential: cookie }));
  const preview = async (definition: string) =>
    ok<Preview>(
      await call(`${schema}/preview`, {
        body: { definition },
        credential: cookie,
      }),
    );
  const apply = (body: Record<string, unknown>, key = crypto.randomUUID()) =>
    call(schema, { body, credential: cookie, key });

  // 1. First project: nothing applied, revision 0.
  const empty = await read();
  expect(empty).toMatchObject({ schema: null, revision: 0 });
  let source = serializeDefinitionDocument(
    setIn(doc("schema_version = 1\n"), ["work_units", "task"], {
      fields: [{ name: "title", type: "string", required: true, ui_width: 40 }],
      owner_hint: "custom key kept by the server",
    }),
  );
  source = serializeDefinitionDocument(
    setIn(doc(source), ["artifacts", "plan"], {
      mime_types: ["text/markdown"],
      retention_days: 30,
    }),
  );
  const first = await preview(source);
  expect(first.revision).toBe(0);
  const created = await apply({
    definition: source,
    expected_revision: 0,
    reviewed_definition: first.reviewed_definition,
  });
  expect(await ok<{ revision: number }>(created)).toMatchObject({
    revision: 1,
  });

  // 2. Add an unused type.
  const withFeature = serializeDefinitionDocument(
    setIn(doc(source), ["work_units", "feature"], {}),
  );
  const added = await preview(withFeature);
  expect(added.changes).toEqual([
    { kind: "work-unit-added", unitType: "feature" },
  ]);
  await ok(
    await apply({
      definition: withFeature,
      expected_revision: 1,
      reviewed_definition: added.reviewed_definition,
    }),
  );

  // 3. Shorten retention: preview explains it; it needs a reviewed strategy.
  const shorter = serializeDefinitionDocument(
    setIn(doc(withFeature), ["artifacts", "plan", "retention_days"], 7),
  );
  const retention = await preview(shorter);
  expect(retention.autoApplicable).toBe(false);
  expect(retention.changes).toContainEqual({
    kind: "definition-changed",
    path: "artifacts.plan",
    destructive: true,
    impact: {
      liveArtifacts: 0,
      searchChanged: false,
      retention: {
        from: 30,
        to: 7,
        pendingBackfill: 0,
        pendingBackfillUsesNewPolicy: true,
      },
    },
  });
  const unreviewed = await apply({
    definition: shorter,
    expected_revision: 2,
    strategy: "relax",
  });
  expect(unreviewed.status).toBe(428);
  await unreviewed.arrayBuffer();

  // 4. A concurrent edit lands first; the stale apply conflicts and rebases.
  const otherEdit = serializeDefinitionDocument(
    setIn(doc(withFeature), ["records", "deploy"], { format: "yaml" }),
  );
  const other = await preview(otherEdit);
  await ok(
    await apply({
      definition: otherEdit,
      expected_revision: 2,
      reviewed_definition: other.reviewed_definition,
    }),
  );
  const stale = await apply({
    definition: shorter,
    expected_revision: retention.revision,
    reviewed_definition: retention.reviewed_definition,
    strategy: "relax",
  });
  expect(stale.status).toBe(412);
  expect(
    ((await stale.json()) as { error: { revision: number } }).error.revision,
  ).toBe(3);
  const latest = await read();
  const merged = rebaseDefinition(
    doc(withFeature),
    doc(shorter),
    doc(latest.schema?.definition ?? ""),
  );
  expect(merged.conflicts).toEqual([]);
  const rebased = serializeDefinitionDocument(merged.merged);
  const review = await preview(rebased);
  expect(review.revision).toBe(3);
  await ok(
    await apply({
      definition: rebased,
      expected_revision: 3,
      reviewed_definition: review.reviewed_definition,
      strategy: "relax",
    }),
  );

  // 5. An invalid template is rejected with the path of the problem.
  const invalid = serializeDefinitionDocument(
    setIn(doc(rebased), ["templates", "release", "entities", "root"], {
      id_suffix: "",
      type: "missing",
    }),
  );
  const rejected = await call(`${schema}/preview`, {
    body: { definition: invalid },
    credential: cookie,
  });
  expect(rejected.status).toBe(400);
  expect(
    ((await rejected.json()) as { error: { errors: unknown[] } }).error.errors,
  ).toContainEqual({
    message: 'references unknown work-unit type "missing"',
    path: "templates.release.entities.root.type",
  });

  // 6. A credential limited to preview cannot apply.
  const issued = await ok<{ token: string }>(
    await call("/api/account/tokens", {
      body: {
        projectId: project,
        name: "previewer",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        policy: {
          role: "participant",
          capabilities: ["schema:read", "schema:preview"],
        },
      },
      credential: cookie,
    }),
  );
  const previewer = `Bearer ${issued.token}`;
  const allowed = await call(`${schema}/preview`, {
    body: { definition: withFeature },
    credential: previewer,
  });
  expect(allowed.status).toBe(200);
  await allowed.arrayBuffer();
  const refused = await call(schema, {
    body: {
      definition: withFeature,
      expected_revision: 4,
      reviewed_definition: withFeature,
      strategy: "relax",
    },
    credential: previewer,
    key: crypto.randomUUID(),
  });
  expect(refused.status).toBe(403);
  await refused.arrayBuffer();

  // 7. Restore revision 2 as a new revision; history is not rewritten.
  const history = await ok<{
    entries: { version: number; definition: string }[];
  }>(await call(`${schema}/history?before=3&limit=1`, { credential: cookie }));
  expect(history.entries[0].version).toBe(2);
  const restore = await preview(history.entries[0].definition);
  expect(restore.changes).toContainEqual(
    expect.objectContaining({
      kind: "record-type-removed",
      typeName: "deploy",
    }),
  );
  const key = crypto.randomUUID();
  const restoreBody = {
    definition: history.entries[0].definition,
    expected_revision: 4,
    reviewed_definition: restore.reviewed_definition,
    strategy: "relax",
  };
  const restored = await ok<{ revision: number }>(
    await apply(restoreBody, key),
  );
  expect(restored.revision).toBe(5);
  // A retry after a lost response replays the receipt, not a sixth revision.
  expect(await ok<{ revision: number }>(await apply(restoreBody, key))).toEqual(
    restored,
  );

  // 8. Keys outside the definition format survived every edit.
  const final = await read();
  expect(final.revision).toBe(5);
  const stored = doc(final.schema?.definition ?? "");
  expect(getIn(stored, ["work_units", "task", "owner_hint"])).toBe(
    "custom key kept by the server",
  );
  expect(getIn(stored, ["artifacts", "plan", "retention_days"])).toBe(30);
});
