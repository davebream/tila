import { SELF, runInDurableObject } from "cloudflare:test";
import type { CredentialPolicy } from "@tila/schemas";
import { expect, it } from "vitest";
import { CredentialStore } from "../../worker/src/d1/credential-store";
import { generateToken } from "../../worker/src/lib/hash";
import { hashToken } from "../../worker/src/lib/hash-token";
import { bindings } from "./setup";

// Metadata-only record reads on the real Worker, Durable Object SQLite and D1
// credential store: `GET /records/:type/:key?meta=1`.

const SECRET = "RUNTIME-VALUE-SECRET";
const CAPS = ["records:read", "records:write", "records:delete"] as const;

async function project() {
  const projectId = `meta-${crypto.randomUUID()}`;
  await bindings.DB.prepare(
    "INSERT INTO _projects (project_id, display_name, created_at, created_by, cloudflare_account_id) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(projectId, projectId, Date.now(), "fixture", "local")
    .run();
  const token = `token-${crypto.randomUUID()}`;
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
  const as =
    (bearer: string) =>
    (
      path: string,
      body?: unknown,
      method = body === undefined ? "GET" : "POST",
    ) =>
      SELF.fetch(`https://worker/projects/${projectId}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${bearer}`,
          "X-Tila-Participant-Id": "meta-runtime",
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
  return { projectId, request: as(token), as };
}

async function scopedToken(projectId: string, policy: CredentialPolicy) {
  const store = new CredentialStore(bindings.DB);
  const actor = { principalId: "fixture" };
  const service = await store.createService(
    projectId,
    {
      name: `svc-${crypto.randomUUID().slice(0, 8)}`,
      display_name: "Meta reader",
      role: "participant",
    },
    actor,
  );
  const token = await generateToken();
  await store.issue(
    {
      projectId,
      principalId: service.principal_id,
      name: `meta-key-${crypto.randomUUID().slice(0, 8)}`,
      tokenHash: await hashToken(token, bindings.HASH_PEPPER),
      policy,
    },
    actor,
  );
  return token;
}

type Meta = {
  ok: boolean;
  meta: {
    type: string;
    key: string;
    revision: number;
    fence: number;
    value_sha256: string;
    updated_at: number;
    archived: number;
  };
};

it("reads one consistent revision and fence across writes, archive and unarchive", async () => {
  const { projectId, request } = await project();
  const created = await request("/records/config", {
    key: "svc/api",
    value: { note: SECRET },
    tags: ["runtime-tag-secret"],
  });
  expect(created.status).toBe(201);
  const first = await created.json<{ fence: number; revision: number }>();

  const plain = await request("/records/config/svc/api");
  const plainText = await plain.text();
  expect(Object.keys(JSON.parse(plainText)).sort()).toEqual([
    "fence",
    "ok",
    "record",
  ]);
  expect(plainText).toContain(SECRET);

  const metaResponse = await request("/records/config/svc/api?meta=1");
  const metaText = await metaResponse.text();
  expect(metaResponse.status, metaText).toBe(200);
  // No cache may answer a read used to validate a copy or learn the fence.
  expect(metaResponse.headers.get("Cache-Control")).toBe("private, no-store");
  expect(metaText).not.toContain(SECRET);
  expect(metaText).not.toContain("runtime-tag-secret");
  const meta = JSON.parse(metaText) as Meta;
  const full = JSON.parse(plainText) as {
    record: { value_sha256: string; updated_at: number };
    fence: number;
  };
  expect(meta).toEqual({
    ok: true,
    meta: {
      type: "config",
      key: "svc/api",
      revision: first.revision,
      fence: first.fence,
      value_sha256: full.record.value_sha256,
      updated_at: full.record.updated_at,
      archived: 0,
    },
  });

  // Fenced replaces: the fence read from the metadata is the fence accepted.
  let current = meta.meta;
  for (const note of ["two", "three"]) {
    const set = await request(
      "/records/config/svc/api",
      { value: { note }, fence: current.fence },
      "PUT",
    );
    expect(set.status, await set.clone().text()).toBe(200);
    await set.text();
    const next = (
      await (await request("/records/config/svc/api?meta=1")).json<Meta>()
    ).meta;
    expect(next.revision).toBe(current.revision + 1);
    expect(next.fence).toBe(current.fence + 1);
    expect(next.fence).toBe(next.revision);
    current = next;
  }

  const archived = await request("/records/config/~/archive/svc/api", {
    fence: current.fence,
  });
  expect(archived.status).toBe(200);
  await archived.text();
  const afterArchive = (
    await (await request("/records/config/svc/api?meta=1")).json<Meta>()
  ).meta;
  expect(afterArchive).toMatchObject({
    archived: 1,
    revision: current.revision + 1,
    fence: current.fence + 1,
    value_sha256: current.value_sha256,
  });

  const restored = await request("/records/config/~/unarchive/svc/api", {
    fence: afterArchive.fence,
  });
  expect(restored.status).toBe(200);
  await restored.text();
  const afterUnarchive = (
    await (await request("/records/config/svc/api?meta=1")).json<Meta>()
  ).meta;
  expect(afterUnarchive).toMatchObject({
    archived: 0,
    revision: afterArchive.revision + 1,
    fence: afterArchive.fence + 1,
  });

  // The fence the metadata reports is the stored one in the real DO SQLite.
  const stub = bindings.PROJECT.get(bindings.PROJECT.idFromName(projectId));
  await runInDurableObject(stub, (_instance, state) => {
    expect(
      state.storage.sql
        .exec(
          "SELECT current_fence FROM fences WHERE resource = 'record:config/svc/api'",
        )
        .one(),
    ).toMatchObject({ current_fence: afterUnarchive.fence });
    expect(
      state.storage.sql
        .exec(
          "SELECT revision FROM records WHERE type = 'config' AND key = 'svc/api'",
        )
        .one(),
    ).toMatchObject({ revision: afterUnarchive.revision });
  });
});

it("answers a missing record and a malformed meta like the ordinary read", async () => {
  const { request } = await project();
  await (
    await request("/records/config", { key: "present", value: { v: 1 } })
  ).text();

  const plainMissing = await request("/records/config/absent");
  const metaMissing = await request("/records/config/absent?meta=1");
  expect(metaMissing.status).toBe(404);
  expect(await metaMissing.json()).toEqual(await plainMissing.json());

  for (const query of ["meta=true", "meta=0", "meta=", "meta=1&meta=1"]) {
    const bad = await request(`/records/config/present?${query}`);
    const text = await bad.text();
    expect(bad.status, query).toBe(400);
    expect(JSON.parse(text)).toMatchObject({
      ok: false,
      error: { code: "validation-error" },
    });
  }
});

it("gives a write-only or out-of-prefix credential the ordinary read's denial", async () => {
  const { projectId, request, as } = await project();
  for (const [type, key] of [
    ["answer", "a1/x"],
    ["answer", "z9/out"],
    ["question", "q1/old"],
  ]) {
    const made = await request(`/records/${type}`, {
      key,
      value: { note: SECRET },
    });
    expect(made.status).toBe(201);
    await made.text();
  }
  const base = { role: "participant" as const, capabilities: [...CAPS] };
  const readAnswers = await scopedToken(projectId, {
    ...base,
    restrictions: {
      records_read: [{ type: "answer", key_prefixes: ["a1"] }],
      records_write: [{ type: "question", key_prefixes: ["q1"] }],
    },
  });
  const writeOnly = await scopedToken(projectId, {
    ...base,
    restrictions: {
      records_write: [{ type: "question", key_prefixes: ["q1"] }],
    },
  });

  const allowed = await as(readAnswers)("/records/answer/a1/x?meta=1");
  const allowedText = await allowed.text();
  expect(allowed.status, allowedText).toBe(200);
  expect(allowed.headers.get("Cache-Control")).toBe("private, no-store");
  // The ordinary read of the same key keeps the scoped-response header.
  const ordinary = await as(readAnswers)("/records/answer/a1/x");
  expect(ordinary.headers.get("Cache-Control")).toBe("no-store");
  await ordinary.text();
  expect(JSON.parse(allowedText)).toMatchObject({
    ok: true,
    meta: { type: "answer", key: "a1/x", revision: 1 },
  });
  expect(allowedText).not.toContain(SECRET);

  for (const [token, path] of [
    [readAnswers, "/records/question/q1/old"],
    [readAnswers, "/records/answer/z9/out"],
    [writeOnly, "/records/question/q1/old"],
    [writeOnly, "/records/question/q1/never-written"],
  ] as const) {
    const plain = await as(token)(path);
    const plainBody = await plain.text();
    const meta = await as(token)(`${path}?meta=1`);
    const metaBody = await meta.text();
    expect(plain.status, path).toBe(403);
    expect(meta.status, path).toBe(403);
    expect(JSON.parse(metaBody)).toEqual(JSON.parse(plainBody));
    expect(metaBody).not.toContain(SECRET);
    expect(metaBody).not.toContain("revision");
  }
});
