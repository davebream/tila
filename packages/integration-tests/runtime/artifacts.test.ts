import {
  SELF,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { parseSchemaToml } from "@tila/core";
import { artifactVersionOps, schema } from "@tila/ops-sqlite";
import { artifactCommitKey } from "@tila/schemas";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { expect, it } from "vitest";
import { createProjectRouter } from "../../backend-do/src/project-do-router";
import { hashToken } from "../../worker/src/lib/hash-token";
import { identity, post } from "./helpers";
import { bindings } from "./setup";

it("returns a readable 410 envelope for deleted revision content through the Worker", async () => {
  const projectId = "runtime-deleted-artifact";
  const token = "runtime-artifact-token";
  await bindings.DB.prepare(
    "INSERT INTO _projects (project_id, display_name, created_at, created_by, cloudflare_account_id) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(projectId, projectId, Date.now(), "fixture", "local")
    .run();
  await bindings.DB.prepare(
    "INSERT INTO _tokens (token_hash, project_id, name, scopes, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      await hashToken(token, undefined),
      projectId,
      "init",
      "full",
      Date.now(),
      "fixture",
    )
    .run();
  const request = async <T = unknown>(
    path: string,
    method = "GET",
    body?: unknown,
  ) => {
    const response = await SELF.fetch(
      `https://worker/projects/${projectId}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Tila-Participant-Id": "runtime-worker",
          "Content-Type": "application/json",
          "Idempotency-Key": path,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    return {
      status: response.status,
      body: await response.json<T>(),
    };
  };
  const claim = await request<{ fence: number }>("/claims/acquire", "POST", {
    resource: "artifact:report",
    mode: "exclusive",
    ttl_ms: 60_000,
  });
  expect(claim.status).toBe(200);
  const written = await request<{ key: string }>("/artifacts/text", "POST", {
    content: "deleted content",
    kind: "report",
    mime_type: "text/plain",
    lineage_id: "report",
    lineage_fence: claim.body.fence,
  });
  expect(written.status).toBe(200);
  const path = `/artifacts/${encodeURIComponent(written.body.key)}`;
  expect(
    (await request(`${path}?fence=${claim.body.fence}`, "DELETE")).status,
  ).toBe(202);
  const unavailable = await request(path);
  expect(unavailable.status).toBe(410);
  expect(unavailable.body).toMatchObject({
    ok: false,
    error: { code: "artifact-unavailable", retryable: false },
  });
});

it("recovers interrupted R2 publication after eviction without duplicate logical records", async () => {
  const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
  const content = "runtime artifact content";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  const sha256 = Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  const claim = await (
    await post(stub, "/coord/acquire", {
      resource: "artifact:runtime-lineage",
      mode: "exclusive",
      ttl_ms: 60_000,
    })
  ).json<{ fence: number }>();
  const reserved = await post(stub, "/artifact/version/reserve", {
    project_id: "runtime-project",
    operation_id: "runtime-operation",
    request_hash: sha256,
    lineage_id: "runtime-lineage",
    lineage_fence: claim.fence,
    kind: "document",
    resource: null,
    sha256,
    bytes: content.length,
    mime_type: "text/plain",
    fence: null,
  });
  expect(reserved.status, await reserved.text()).toBe(200);
  const record = await runInDurableObject(stub, (_instance, state) => {
    const db = drizzle(state.storage, { schema });
    const operation = artifactVersionOps.getRevisionOperation(
      db,
      "runtime-operation",
    );
    if (!operation) throw new Error("Missing reserved operation");
    return artifactVersionOps.revisionRecord(operation);
  });
  await bindings.ARTIFACTS.put(record.pointer.r2_key, content, {
    customMetadata: { "tila-sha256": sha256 },
  });

  // Fault only the commit-record write; content and all other calls use local R2.
  await runInDurableObject(stub, async (_instance, state) => {
    const db = drizzle(state.storage, { schema });
    const unavailable = new Proxy(bindings.ARTIFACTS, {
      get(target, property) {
        if (property === "put")
          return () =>
            Promise.reject(new Error("injected publication interruption"));
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const router = createProjectRouter({
      ctx: state,
      db,
      enrichOpts: () => ({ db, parseSchemaToml }),
      artifacts: unavailable,
    });
    const failed = await router.fetch(
      new Request("https://project/artifact/version/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...identity,
          operation_id: "runtime-operation",
        }),
      }),
    );
    expect(failed.status).toBe(503);
    expect(
      artifactVersionOps.getRevisionOperation(db, "runtime-operation")?.state,
    ).toBe("accepted");
    expect(await state.storage.getAlarm()).not.toBeNull();
  });
  expect(
    await bindings.ARTIFACTS.get(artifactCommitKey(record.pointer)),
  ).toBeNull();
  await evictDurableObject(stub);
  const restored = bindings.PROJECT.get(stub.id);
  await restored.fetch("https://project/coord/claims");
  expect(await runDurableObjectAlarm(restored)).toBe(true);
  const retry = await post(restored, "/artifact/version/commit", {
    operation_id: "runtime-operation",
  });
  expect(retry.status, await retry.text()).toBe(200);
  const blob = await bindings.ARTIFACTS.get(record.pointer.r2_key);
  const commit = await bindings.ARTIFACTS.get(
    artifactCommitKey(record.pointer),
  );
  if (!blob || !commit)
    throw new Error("Missing published R2 content or commit record");
  expect(await blob.text()).toBe(content);
  expect(await commit.json()).toEqual(record);
  await runInDurableObject(restored, (_instance, state) => {
    const db = drizzle(state.storage, { schema });
    expect(
      artifactVersionOps.getArtifactMeta(db, record.pointer.r2_key).sha256,
    ).toBe(sha256);
    expect(
      artifactVersionOps.getRevisionOperation(db, "runtime-operation")?.state,
    ).toBe("published");
    expect(
      state.storage.sql
        .exec("SELECT count(*) AS n FROM artifact_revisions")
        .one().n,
    ).toBe(1);
    expect(
      state.storage.sql
        .exec("SELECT count(*) AS n FROM artifact_pointers")
        .one().n,
    ).toBe(1);
  });
});
