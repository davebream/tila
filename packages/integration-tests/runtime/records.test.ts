import { SELF, runInDurableObject } from "cloudflare:test";
import { canonicalJson, canonicalJsonSha256 } from "@tila/schemas";
import { expect, it } from "vitest";
import { CredentialStore } from "../../worker/src/d1/credential-store";
import { generateToken } from "../../worker/src/lib/hash";
import { hashToken } from "../../worker/src/lib/hash-token";
import { bindings } from "./setup";

const definition = `schema_version = 1
[records.config]
format = "json"
history = "snapshot"
[records.config.fields]
region = { type = "string", required = true }
[records.revision]
format = "json"
history = "revision"
[records.revision.fields]
region = { type = "string", required = true }
[artifacts.log]
`;

async function fixture() {
  const projectId = `snapshots-${crypto.randomUUID()}`;
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
  const request = (
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) =>
    SELF.fetch(`https://worker/projects/${projectId}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Tila-Participant-Id": "snapshot-writer",
        ...(body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body:
        body === undefined
          ? undefined
          : body instanceof FormData
            ? body
            : JSON.stringify(body),
    });
  const applied = await request("/schema", {
    definition,
    expected_revision: 0,
  });
  expect(applied.status, await applied.text()).toBe(200);
  const stub = bindings.PROJECT.get(bindings.PROJECT.idFromName(projectId));
  return { request, stub, projectId, token };
}

type Mutation = {
  ok: boolean;
  fence: number;
  revision: number;
  record: { value: Record<string, unknown> };
};
async function mutation(response: Response, status = 200) {
  const body = await response.json<Mutation>();
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(body.ok).toBe(true);
  return body;
}

type History = {
  items: {
    revision: number;
    canonical_artifact_key: string | null;
    source_artifact_key: string | null;
  }[];
};

it("creates, sets, puts and patches snapshot records with retrievable canonical artifacts", async () => {
  const { request, stub } = await fixture();
  const key = "api/staging";
  const values = [
    { region: "Wrocław" },
    { region: "eu-west" },
    { region: "us-east" },
  ];
  let result = await mutation(
    await request("/records/config", { key, value: values[0] }),
    201,
  );
  expect(result.revision).toBe(1);
  result = await mutation(
    await request(
      `/records/config/${key}`,
      { value: values[1], fence: result.fence },
      "PUT",
    ),
  );
  expect(result.revision).toBe(2);
  result = await mutation(
    await request(
      `/records/config/${key}`,
      { patch: values[2], fence: result.fence },
      "PATCH",
    ),
  );
  expect(result.revision).toBe(3);
  result = await mutation(
    await request(`/records/config/~/put/${key}`, { value: values[2] }),
  );
  expect(result.revision).toBe(4);
  await mutation(
    await request("/records/config/~/put/put-created", { value: values[0] }),
  );

  const historyResponse = await request(
    `/records/config/~/history/${key}?values=true`,
  );
  expect(historyResponse.status).toBe(200);
  const history = await historyResponse.json<History>();
  expect(history.items.map((item) => item.revision)).toEqual([4, 3, 2, 1]);
  expect(history.items[0].canonical_artifact_key).toBe(
    history.items[1].canonical_artifact_key,
  );
  for (const [i, value] of values.entries()) {
    const artifactKey = `produced/record:config/${key}/${await canonicalJsonSha256(value)}.json`;
    expect(
      history.items.find((item) => item.revision === i + 1)
        ?.canonical_artifact_key,
    ).toBe(artifactKey);
    const download = await request(`/artifacts/${artifactKey}`);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe(canonicalJson(value));
    const blob = await bindings.ARTIFACTS.get(artifactKey);
    expect(blob?.size).toBe(
      new TextEncoder().encode(canonicalJson(value)).byteLength,
    );
  }
  await runInDurableObject(stub, (_instance, state) => {
    expect(state.storage.sql.exec("PRAGMA foreign_keys").one()).toMatchObject({
      foreign_keys: 1,
    });
    const pointers = state.storage.sql
      .exec(
        "SELECT bytes, sha256 FROM artifact_pointers WHERE resource = ?",
        `record:config/${key}`,
      )
      .toArray();
    expect(pointers).toHaveLength(3);
    expect(pointers.every((pointer) => Number(pointer.bytes) > 0)).toBe(true);
    expect(
      state.storage.sql
        .exec(
          "SELECT count(*) AS n FROM journal WHERE kind = 'artifact.produced' AND resource = ?",
          `record:config/${key}`,
        )
        .one(),
    ).toMatchObject({ n: 3 });
    expect(
      state.storage.sql.exec("PRAGMA foreign_key_check").toArray(),
    ).toEqual([]);
  });
  await mutation(
    await request("/records/revision", { key: "main", value: values[0] }),
    201,
  );
  const revisions = await (
    await request("/records/revision/~/history/main")
  ).json<History>();
  expect(revisions.items[0].canonical_artifact_key).toBeNull();
});

it("rejects invalid writes and rolls back a full write when its snapshot pointer fails", async () => {
  const { request, stub } = await fixture();
  const created = await mutation(
    await request("/records/config", {
      key: "main",
      value: { region: "initial" },
    }),
    201,
  );
  const invalid = await request("/records/config", {
    key: "invalid",
    value: {},
  });
  expect(invalid.status).toBe(422);
  await invalid.text();
  const duplicate = await request("/records/config", {
    key: "main",
    value: { region: "duplicate" },
  });
  expect(duplicate.status).toBe(409);
  await duplicate.text();
  const stale = await request(
    "/records/config/main",
    { value: { region: "stale" }, fence: created.fence - 1 },
    "PUT",
  );
  expect(stale.status).toBe(409);
  await stale.text();
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      "CREATE TRIGGER reject_snapshot BEFORE INSERT ON artifact_pointers WHEN NEW.kind = 'record-snapshot-canonical' BEGIN SELECT RAISE(ABORT, 'snapshot-test-failure'); END",
    );
  });
  for (const [path, body, method] of [
    ["/records/config", { key: "failed", value: { region: "create" } }, "POST"],
    [
      "/records/config/main",
      { value: { region: "set" }, fence: created.fence },
      "PUT",
    ],
    ["/records/config/~/put/main", { value: { region: "put" } }, "POST"],
  ] as const) {
    const failed = await request(path, body, method);
    expect(failed.status).toBe(500);
    await failed.text();
  }
  await runInDurableObject(stub, (_instance, state) => {
    expect(
      state.storage.sql.exec("SELECT key, revision FROM records").toArray(),
    ).toEqual([{ key: "main", revision: 1 }]);
    expect(
      state.storage.sql
        .exec("SELECT count(*) AS n FROM record_revisions")
        .one(),
    ).toMatchObject({ n: 1 });
    expect(
      state.storage.sql
        .exec(
          "SELECT current_fence FROM fences WHERE resource = 'record:config/main'",
        )
        .one(),
    ).toMatchObject({ current_fence: created.fence });
    expect(
      state.storage.sql
        .exec("SELECT count(*) AS n FROM journal WHERE kind LIKE 'record.%'")
        .one(),
    ).toMatchObject({ n: 1 });
    expect(
      state.storage.sql
        .exec("SELECT count(*) AS n FROM record_search_docs")
        .one(),
    ).toMatchObject({ n: 1 });
  });
  // Patch has already committed before its optional snapshot phase. A failed
  // stamp must leave neither a dangling revision key nor a partial pointer.
  const patched = await mutation(
    await request(
      "/records/config/main",
      { patch: { region: "patched" }, fence: created.fence },
      "PATCH",
    ),
  );
  expect(patched.revision).toBe(2);
  const history = await (
    await request("/records/config/~/history/main")
  ).json<History>();
  expect(history.items[0].canonical_artifact_key).toBeNull();
});

it("accepts source preuploads only for valid snapshot resources without task fences", async () => {
  const { request, stub } = await fixture();
  const upload = async (
    resource: string,
    kind = "record-snapshot-source",
    content = '{"region":"eu"}\n',
  ) => {
    const form = new FormData();
    form.append(
      "file",
      new File([content], "source.json", {
        type: "application/json",
      }),
    );
    form.append("kind", kind);
    form.append("resource", resource);
    return request("/artifacts", form);
  };
  const source = await upload("record:config/api/staging");
  const body = await source.json<{ key: string }>();
  expect(source.status, JSON.stringify(body)).toBe(200);
  await mutation(
    await request("/records/config", {
      key: "api/staging",
      value: { region: "eu" },
      source_artifact_key: body.key,
    }),
    201,
  );
  const history = await (
    await request("/records/config/~/history/api/staging")
  ).json<History>();
  expect(history.items[0].source_artifact_key).toBe(body.key);
  for (const resource of [
    "record:revision/main",
    "record:unknown/main",
    "record:config/../escape",
    "record:config/",
    "task:missing",
  ]) {
    const invalid = await upload(resource);
    expect(invalid.status).toBe(400);
    await invalid.text();
  }
  // Identical source/canonical JSON shares a content-addressed key, regardless
  // of which representation was uploaded first.
  const exact = await mutation(
    await request("/records/config", {
      key: "exact",
      value: { region: "eu" },
    }),
    201,
  );
  const deduplicated = await upload(
    "record:config/exact",
    "record-snapshot-source",
    '{"region":"eu"}',
  );
  const sourceKey = (await deduplicated.json<{ key: string }>()).key;
  expect(deduplicated.status).toBe(200);
  await mutation(
    await request(
      "/records/config/exact",
      {
        value: { region: "eu" },
        fence: exact.fence,
        source_artifact_key: sourceKey,
      },
      "PUT",
    ),
  );
  for (const source_artifact_key of [body.key, "produced/missing.json"]) {
    const invalidSource = await request("/records/config", {
      key: "wrong-owner",
      value: { region: "eu" },
      source_artifact_key,
    });
    expect(invalidSource.status).toBe(422);
    await invalidSource.text();
  }
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE artifact_pointers SET tombstoned = 1 WHERE r2_key = ?",
      sourceKey,
    );
  });
  const unavailable = await request("/records/config/~/put/exact", {
    value: { region: "eu" },
    source_artifact_key: sourceKey,
  });
  expect(unavailable.status).toBe(422);
  await unavailable.text();

  const invalidKind = await upload("record:config/main", "log");
  expect(invalidKind.status).toBe(400);
  await invalidKind.text();
});

it("enforces restricted record namespaces before writing snapshots to R2", async () => {
  const { projectId } = await fixture();
  const store = new CredentialStore(bindings.DB);
  const actor = { principalId: "fixture" };
  const service = await store.createService(
    projectId,
    {
      name: "snapshot-writer",
      display_name: "Snapshot writer",
      role: "participant",
    },
    actor,
  );
  const token = await generateToken();
  await store.issue(
    {
      projectId,
      principalId: service.principal_id,
      name: "snapshot-key",
      tokenHash: await hashToken(token, bindings.HASH_PEPPER),
      policy: {
        role: "participant",
        capabilities: [
          "records:read",
          "records:write",
          "artifacts:read",
          "artifacts:write",
        ],
        restrictions: {
          records: [{ type: "config", key_prefixes: ["team/a"] }],
        },
      },
    },
    actor,
  );
  const request = (path: string, body: unknown, method = "POST") =>
    SELF.fetch(`https://worker/projects/${projectId}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Tila-Participant-Id": "restricted",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const created = await mutation(
    await request("/records/config", {
      key: "team/a/head",
      value: { region: "allowed" },
    }),
    201,
  );
  await mutation(
    await request(
      "/records/config/team/a/head",
      { patch: { region: "patched" }, fence: created.fence },
      "PATCH",
    ),
  );
  const before = (await bindings.ARTIFACTS.list()).objects.map((o) => o.key);
  expect(before).toHaveLength(2);
  for (const [path, body] of [
    ["/records/config", { key: "team/ab/head", value: { region: "denied" } }],
    ["/records/config/~/put/team/ab/head", { value: { region: "denied" } }],
    [
      "/artifacts/text",
      {
        kind: "record-snapshot-source",
        resource: "record:config/team/ab/head",
        content: "denied",
      },
    ],
  ] as const) {
    const denied = await request(path, body);
    expect(denied.status).toBe(403);
    await denied.text();
  }
  expect((await bindings.ARTIFACTS.list()).objects.map((o) => o.key)).toEqual(
    before,
  );
});
