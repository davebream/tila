import { SELF, evictDurableObject } from "cloudflare:test";
import type { JournalResponse, SchemaApplyResponse } from "@tila/schemas";
import { TilaClient, createSchemaMethods } from "tila-sdk";
import { expect, it, vi } from "vitest";
import { hashToken } from "../../worker/src/lib/hash-token";
import { post } from "./helpers";
import { bindings } from "./setup";

const definition = `schema_version = 1
[work_units.task.fields.title]
type = "string"
required = true
`;

it("serializes configuration races and retains transactional receipts across DO eviction", async () => {
  const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
  const contenders = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      post(stub, "/schema/apply", {
        definition: `${definition}\n# contender ${i}`,
        applied_by: "runtime",
        expected_revision: 0,
        idempotency_key: `apply-${i}`,
      }),
    ),
  );
  expect(contenders.filter((r) => r.status === 200)).toHaveLength(1);
  expect(contenders.filter((r) => r.status === 412)).toHaveLength(7);
  const winner = contenders.findIndex((r) => r.status === 200);
  const result = await contenders[winner].json();
  expect(result).toMatchObject({ warnings: [] });
  await Promise.all(
    contenders.filter((_, i) => i !== winner).map((r) => r.arrayBuffer()),
  );
  await evictDurableObject(stub);
  const retry = await post(bindings.PROJECT.get(stub.id), "/schema/apply", {
    definition: `${definition}\n# contender ${winner}`,
    applied_by: "runtime",
    expected_revision: 0,
    idempotency_key: `apply-${winner}`,
  });
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual(result);
  const history = await (
    await stub.fetch("https://project/schema/history")
  ).json<{ entries: unknown[] }>();
  expect(history.entries).toHaveLength(1);
});

it("checks the reviewed definition and current revision before a destructive apply", async () => {
  const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
  expect(
    (
      await post(stub, "/schema/apply", {
        definition,
        applied_by: "runtime",
        expected_revision: 0,
      })
    ).status,
  ).toBe(200);
  const destructive = "schema_version = 1\nwork_units = {}";
  const review = await (
    await post(stub, "/schema/preview", { definition: destructive })
  ).json<{ revision: number; reviewed_definition: string }>();
  const changed = await post(stub, "/schema/apply", {
    definition: destructive,
    expected_revision: review.revision,
    reviewed_definition: definition,
    strategy: "force",
    applied_by: "runtime",
  });
  expect(changed.status).toBe(412);
  expect(await changed.json()).not.toHaveProperty("warnings");
  const valid = await post(stub, "/schema/apply", {
    definition: destructive,
    expected_revision: review.revision,
    reviewed_definition: review.reviewed_definition,
    strategy: "force",
    applied_by: "runtime",
  });
  expect(valid.status).toBe(200);
  const staleEntity = await post(stub, "/entity/create", {
    id: "stale",
    type: "task",
    data: { title: "stale" },
    schema_version: 1,
    created_by: "runtime",
  });
  expect(staleEntity.status).toBe(422);
});

it("persists revisionless warnings and one minimal event across receipt replay and DO eviction", async () => {
  const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
  const body = {
    definition,
    applied_by: "legacy script",
    idempotency_key: "legacy",
    environment: { client_name: "http", machine: "runtime-host" },
  };
  const first = await (
    await post(stub, "/schema/apply", body)
  ).json<SchemaApplyResponse>();
  expect(first).toMatchObject({
    ok: true,
    revision: 1,
    warnings: [
      {
        code: "schema-revision-deprecated",
        observed_revision: 0,
        result_revision: 1,
      },
    ],
  });
  const nextDefinition = `${definition}\n[work_units.task.fields.note]\ntype = "string"`;
  expect(
    (
      await post(stub, "/schema/apply", {
        definition: nextDefinition,
        applied_by: "editor",
        expected_revision: 1,
      })
    ).status,
  ).toBe(200);
  await evictDurableObject(stub);
  const retry = await post(
    bindings.PROJECT.get(stub.id),
    "/schema/apply",
    body,
  );
  expect(await retry.json()).toEqual(first);
  const noChange = await (
    await post(stub, "/schema/apply", {
      definition: nextDefinition,
      applied_by: "script",
    })
  ).json<SchemaApplyResponse>();
  expect(noChange).toMatchObject({
    noChange: true,
    warnings: [
      {
        observed_revision: 2,
        result_revision: 2,
      },
    ],
  });
  for (const rejected of [
    "schema_version = [",
    "schema_version = 1\nwork_units = {}",
  ]) {
    const response = await post(stub, "/schema/apply", {
      definition: rejected,
      applied_by: "script",
    });
    expect(response.ok).toBe(false);
    expect(await response.json()).not.toHaveProperty("warnings");
  }
  const journal = await (
    await stub.fetch(
      "https://project/journal/list?kind=schema.revisionless_applied",
    )
  ).json<JournalResponse>();
  expect(journal.events).toHaveLength(1);
  expect(journal.events[0]).toMatchObject({
    kind: "schema.revisionless_applied",
    principal_id: "runtime-principal",
    participant_id: "runtime-worker",
    environment: body.environment,
    data: {
      actor: "legacy script",
      idempotency_key: "legacy",
      expected_revision: null,
      observed_revision: 0,
      result_revision: 1,
    },
  });
  expect(JSON.stringify(journal)).not.toContain("work_units");
  const history = await (
    await stub.fetch("https://project/schema/history")
  ).json<{ entries: unknown[] }>();
  expect(history.entries).toHaveLength(2);
});

it("requires revisions in managed projects even for cached revisionless writes and no-change receipts", async () => {
  const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
  const body = { definition, applied_by: "legacy" };
  for (const key of ["write", "no-change"])
    expect(
      (await post(stub, "/schema/apply", { ...body, idempotency_key: key }))
        .status,
    ).toBe(200);
  expect(
    (
      await post(stub, "/queue/configure", {
        authorized_role: "maintainer",
        command: {
          idempotency_key: "enable",
          expected_revision: 0,
          enabled: true,
          execution_limit: 1,
        },
      })
    ).status,
  ).toBe(200);
  await evictDurableObject(stub);
  for (const key of ["write", "no-change", "new"]) {
    const response = await post(stub, "/schema/apply", {
      ...body,
      idempotency_key: key,
    });
    expect(response.status).toBe(428);
    expect(await response.json()).toMatchObject({
      error: { code: "schema-revision-required" },
    });
  }
  const allowed = await post(stub, "/schema/apply", {
    ...body,
    expected_revision: 1,
  });
  expect(await allowed.json()).toMatchObject({ noChange: true, warnings: [] });
});

it("exposes real HTTP warnings to SDK sinks and the authenticated journal without stdout diagnostics", async () => {
  const projectId = `revision-warning-${crypto.randomUUID()}`;
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
      "legacy client",
      "full",
      Date.now(),
      "fixture",
    )
    .run();
  const sink = vi.fn();
  const client = new TilaClient({
    baseUrl: "https://worker",
    token,
    participantId: "sdk-worker",
    environment: { client_name: "sdk", machine: "runtime-host" },
    // Service bindings accept manual/follow, unlike the SDK's Node fetch.
    // No redirects are followed by this in-process test transport.
    fetch: (input, init) => SELF.fetch(input, { ...init, redirect: "manual" }),
    warningSink: sink,
  });
  const schema = createSchemaMethods(client, projectId);
  const options = { idempotency_key: "http-retry" };
  const first = await schema.apply(definition, undefined, options);
  expect(sink).toHaveBeenCalledExactlyOnceWith(first.warnings?.[0]);
  expect(await schema.apply(definition, undefined, options)).toEqual(first);
  expect(sink).toHaveBeenCalledTimes(2);
  const noChange = await schema.apply(definition);
  expect(noChange).toMatchObject({
    noChange: true,
    warnings: [{ observed_revision: 1, result_revision: 1 }],
  });
  await expect(
    schema.apply(definition, undefined, { expected_revision: 0 }),
  ).rejects.toMatchObject({ status: 412 });
  expect(sink).toHaveBeenCalledTimes(3);
  const journal = await client.get<JournalResponse>(
    `/projects/${projectId}/journal`,
    {
      query: { kind: "schema.revisionless_applied" },
    },
  );
  expect(journal.events).toHaveLength(1);
  expect(journal.events[0]).toMatchObject({
    participant_id: "sdk-worker",
    environment: { client_name: "sdk", machine: "runtime-host" },
    data: { observed_revision: 0, result_revision: 1 },
  });
  expect(JSON.stringify(journal)).not.toContain(token);
  expect(JSON.stringify(journal)).not.toContain("work_units");
});
