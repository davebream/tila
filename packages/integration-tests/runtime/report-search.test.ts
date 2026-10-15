import { SELF, evictDurableObject, runInDurableObject } from "cloudflare:test";
import type { CredentialPolicy, UnifiedSearchResponse } from "@tila/schemas";
import { expect, it } from "vitest";
import { CredentialStore } from "../../worker/src/d1";
import { archiveJournal } from "../../worker/src/lib/admin-ops";
import { hashToken } from "../../worker/src/lib/hash";
import type { Env } from "../../worker/src/types";
import { queueApiFixture } from "./queue-api-fixture";
import { bindings } from "./setup";

it("searches real archived reports, rebuilds historical FTS and resumes after eviction", async () => {
  const t = await queueApiFixture();
  const stub = bindings.PROJECT.get(bindings.PROJECT.idFromName(t.project));
  const report = await t.http(
    "/journal",
    {
      event_name: "pipeline.completed",
      event_version: 1,
      target: { kind: "project" },
      data: { nested: ["archiveneedle"] },
    },
    "worker",
    "report-search",
  );
  expect(report.status, await report.clone().text()).toBe(200);
  const seq = ((await report.json()) as { event: { seq: number } }).event.seq;
  const search = async () => {
    const response = await t.http("/search?q=archiveneedle&kind=report");
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json() as Promise<UnifiedSearchResponse>;
  };
  expect((await search()).results).toMatchObject([{ type: "report", seq }]);
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE journal SET t = ?",
      Date.now() - 100 * 86400000,
    );
  });
  expect(
    (
      await archiveJournal(
        { ARTIFACTS: bindings.ARTIFACTS } as unknown as Env,
        stub,
        t.project,
      )
    ).status,
  ).toBe(200);
  expect((await search()).results).toHaveLength(1);
  // Model an upgraded database whose reports predate synchronous indexing.
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.deleteAlarm();
    state.storage.sql.exec("DELETE FROM report_search_docs");
    state.storage.sql.exec("DELETE FROM report_search_state");
  });
  const partial = await search();
  expect(partial.results).toEqual([]);
  expect(partial.scope?.report_history?.status).toBe("running");
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put("_reindex_state", {
      kind: "entity",
      batchSize: 50,
      processed: 0,
      startedAt: Date.now(),
      attempts: 0,
    });
  });
  await evictDurableObject(stub);
  await runInDurableObject(stub, async (instance) => {
    if (!instance.alarm)
      throw new Error("Missing Durable Object alarm handler");
    await instance.alarm();
  });
  await runInDurableObject(stub, async (_instance, state) => {
    expect(await state.storage.get("_reindex_state")).toBeUndefined();
  });
  const indexed = await search();
  expect(indexed.scope?.report_history).toMatchObject({
    status: "complete",
    archived: "included",
  });
  expect(indexed.results).toMatchObject([{ type: "report", seq }]);
  const replay = await t.http(
    `/journal/replay?after_seq=${seq - 1}&through_seq=${seq}`,
  );
  expect(replay.status).toBe(200);
  expect(((await replay.json()) as { events: unknown[] }).events).toHaveLength(
    1,
  );
});

it("enforces search and journal capabilities without exposing report coverage to restricted readers", async () => {
  const t = await queueApiFixture();
  expect(
    (
      await t.http(
        "/journal",
        {
          event_name: "private.report",
          event_version: 1,
          target: { kind: "project" },
          data: { text: "needle private report text" },
        },
        "worker",
        "private-report",
      )
    ).status,
  ).toBe(200);
  const store = new CredentialStore(bindings.DB);
  const actor = { principalId: "fixture" };
  const policies: CredentialPolicy[] = [
    { role: "viewer", capabilities: ["search:read"] },
    { role: "viewer", capabilities: ["journal:read"] },
    {
      role: "viewer",
      capabilities: ["search:read", "journal:read"],
      restrictions: { task_types: ["task"] },
    },
    { role: "viewer", capabilities: ["search:read", "journal:read"] },
  ];
  for (const [index, policy] of policies.entries()) {
    const service = await store.createService(
      t.project,
      { name: `reader-${index}`, display_name: "reader", role: "viewer" },
      actor,
    );
    const token = `tila_${crypto.randomUUID()}${crypto.randomUUID()}`;
    await store.issue(
      {
        projectId: t.project,
        principalId: service.principal_id,
        name: `reader-${index}`,
        tokenHash: await hashToken(token, bindings.HASH_PEPPER),
        policy,
      },
      actor,
    );
    const request = (suffix: string) =>
      SELF.fetch(
        `https://worker/projects/${t.project}/search?q=needle${suffix}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
    const explicit = await request("&kind=report");
    expect(explicit.status).toBe(index === 3 ? 200 : 403);
    const explicitBody = await explicit.text();
    if (index === 3) expect(JSON.parse(explicitBody).results).toHaveLength(1);
    else expect(explicitBody).not.toContain("private report text");
    if (index === 0 || index === 2) {
      const body = (await (await request("")).json()) as UnifiedSearchResponse;
      expect(body.results).toEqual([]);
      expect(body.scope?.report_history).toBeUndefined();
      expect(body.scope?.excluded_kinds).toContainEqual({
        kind: "report",
        reason: index === 2 ? "restricted" : "capability",
      });
    }
  }
});

it("reports exhausted archive retries and resumes after repair without hiding live results", async () => {
  const t = await queueApiFixture();
  const stub = bindings.PROJECT.get(bindings.PROJECT.idFromName(t.project));
  const report = (key: string) =>
    t.http(
      "/journal",
      {
        event_name: "pipeline.checked",
        event_version: 1,
        target: { kind: "project" },
        data: { text: "recoveryneedle" },
      },
      "worker",
      key,
    );
  expect((await report("old")).status).toBe(200);
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE journal SET t = ?",
      Date.now() - 100 * 86400000,
    );
    state.storage.sql.exec("DELETE FROM report_search_docs");
  });
  expect(
    (
      await archiveJournal(
        { ARTIFACTS: bindings.ARTIFACTS } as unknown as Env,
        stub,
        t.project,
      )
    ).status,
  ).toBe(200);
  const objects = await bindings.ARTIFACTS.list({
    prefix: `journal-archive/${t.project}/`,
  });
  expect(objects.objects.length).toBeGreaterThan(0);
  const key = objects.objects[0].key;
  const archived = await bindings.ARTIFACTS.get(key);
  if (!archived) throw new Error("Missing test archive");
  const bytes = await archived.arrayBuffer();
  await bindings.ARTIFACTS.delete(key);
  expect((await report("live")).status).toBe(200);
  await t.http("/search?q=recoveryneedle&kind=report");
  for (let attempt = 0; attempt < 6; attempt++) {
    await runInDurableObject(stub, async (instance, state) => {
      const job =
        await state.storage.get<Record<string, unknown>>("_report_search_job");
      expect(job).toBeDefined();
      await state.storage.put("_report_search_job", { ...job, nextAt: 0 });
      if (!instance.alarm)
        throw new Error("Missing Durable Object alarm handler");
      await instance.alarm();
    });
  }
  const failed = (await (
    await t.http("/search?q=recoveryneedle&kind=report")
  ).json()) as UnifiedSearchResponse;
  expect(failed.results).toHaveLength(1);
  expect(failed.scope?.report_history).toMatchObject({
    status: "failed",
    indexed_through_seq: 0,
    error: "journal-history-unavailable",
  });
  await bindings.ARTIFACTS.put(key, bytes, {
    customMetadata: archived.customMetadata,
  });
  expect((await t.http("/search/reindex", { kind: "report" })).status).toBe(
    200,
  );
  await runInDurableObject(stub, async (instance) => {
    if (!instance.alarm)
      throw new Error("Missing Durable Object alarm handler");
    await instance.alarm();
  });
  const complete = (await (
    await t.http("/search?q=recoveryneedle&kind=report")
  ).json()) as UnifiedSearchResponse;
  expect(complete.results).toHaveLength(2);
  expect(complete.scope?.report_history?.status).toBe("complete");
});
