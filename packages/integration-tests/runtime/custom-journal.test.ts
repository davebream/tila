import { SELF, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { TilaClient, createJournalMethods } from "tila-sdk";
import { expect, it } from "vitest";
import { CredentialStore } from "../../worker/src/d1";
import { hashToken } from "../../worker/src/lib/hash";
import { queueApiFixture } from "./queue-api-fixture";
import { bindings } from "./setup";

const input = {
  event_name: "pipeline.tests_passed",
  event_version: 1,
  target: { kind: "project" as const },
  data: { passed: 87 },
  correlation_id: "run-123",
};

it("returns an explicit retry delay for append throttling while replaying accepted receipts", async () => {
  const { http } = await queueApiFixture();
  let limited: Response | undefined;
  // Allow crossing one fixed-minute boundary while issuing the requests.
  for (let index = 0; index < 121; index++) {
    const response = await http("/journal", input, "worker", `quota-${index}`);
    if (response.status === 429) {
      limited = response;
      break;
    }
    expect(response.status, await response.clone().text()).toBe(200);
  }
  expect(limited).toBeDefined();
  if (!limited) throw new Error("Rate limit did not reject the extra report");
  expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
  expect(await limited.json()).toMatchObject({
    error: { code: "rate-limited", retryable: true },
  });
  const replay = await http("/journal", input, "worker", "quota-0");
  expect(replay.status).toBe(200);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
});

it("persists authenticated reports across concurrent HTTP retries, cold restart and archive replay", async () => {
  const { project, token, http } = await queueApiFixture();
  const reports = await Promise.all(
    Array.from({ length: 5 }, () =>
      http("/journal", input, "worker", "stable-key"),
    ),
  );
  for (const response of reports)
    expect(response.status, await response.clone().text()).toBe(200);
  const first = (await reports[0].json()) as {
    event: { seq: number; principal_id: string };
    dedup_expires_at: number;
  };
  for (const response of reports.slice(1))
    expect(await response.json()).toEqual(first);
  expect(first.event.principal_id).toBeTruthy();
  expect(first.event.seq).toBe(2); // Schema application occupies the first position.
  expect(
    (
      await http(
        "/journal",
        { ...input, data: { passed: 88 } },
        "worker",
        "stable-key",
      )
    ).status,
  ).toBe(422);
  const stub = bindings.PROJECT.get(bindings.PROJECT.idFromName(project));
  await evictDurableObject(stub);
  const retried = await http("/journal", input, "worker", "stable-key");
  expect(retried.headers.get("Idempotency-Replayed")).toBe("true");
  expect(await retried.json()).toEqual(first);
  expect(
    await (
      await http(
        "/journal?event_name=pipeline.tests_passed&correlation_id=run-123",
      )
    ).json(),
  ).toMatchObject({ events: [first.event] });

  const rows = await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec("SELECT * FROM journal ORDER BY seq").toArray(),
  );
  await bindings.ARTIFACTS.put(
    `journal-archive/${project}/custom.jsonl`,
    rows
      .map((row) =>
        JSON.stringify({
          ...row,
          data: JSON.parse(String(row.data)),
          environment: JSON.parse(String(row.environment)),
        }),
      )
      .join("\n"),
    { customMetadata: { first_seq: "1", last_seq: String(first.event.seq) } },
  );
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("DELETE FROM journal");
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO _journal_archive_watermark (id, last_archived_seq, archived_at) VALUES (1, ?, ?)",
      first.event.seq,
      Date.now(),
    );
  });
  expect(
    await (await http("/journal", input, "worker", "stable-key")).json(),
  ).toEqual(first);
  const correction = await http(
    "/journal",
    { ...input, corrects_seq: first.event.seq, data: { passed: 86 } },
    "worker",
    "correction",
  );
  expect(correction.status, await correction.clone().text()).toBe(200);
  const replay = await http("/journal/replay?after_seq=0&limit=10");
  expect(replay.status, await replay.clone().text()).toBe(200);
  expect(await replay.json()).toMatchObject({
    events: [{ seq: 1 }, first.event, { seq: 3, kind: "custom.reported" }],
  });
  const journal = createJournalMethods(
    new TilaClient({
      baseUrl: "https://worker",
      token,
      participantId: "worker",
      fetch: ((url, init) =>
        SELF.fetch(url, { ...init, redirect: "manual" })) as typeof fetch,
    }),
    project,
  );
  const sdkReceipt = await journal.append(
    { ...input, event_name: "pipeline.sdk_observed" },
    { idempotencyKey: "sdk" },
  );
  expect(sdkReceipt.event.seq).toBe(4);
});

it("rejects forged identities, missing authentication, cross-project resources and oversized data", async () => {
  const { project, token, http } = await queueApiFixture();
  expect(
    (
      await http(
        "/journal",
        { ...input, principal_id: "forged" },
        "worker",
        "forged",
      )
    ).status,
  ).toBe(400);
  expect((await http("/journal", input)).status).toBe(400); // Missing required idempotency key.
  expect(
    (await http("/journal", input, "", "missing-participant")).status,
  ).toBe(400);
  expect(
    (
      await SELF.fetch(`https://worker/projects/${project}/journal`, {
        method: "POST",
        body: JSON.stringify(input),
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await http(
        "/journal",
        {
          ...input,
          target: { kind: "resource", resource: "task:another-project" },
        },
        "worker",
        "cross-project",
      )
    ).status,
  ).toBe(404);
  for (const length of [17_000, 70_000]) {
    const response = await http(
      "/journal",
      { ...input, data: { text: "x".repeat(length) } },
      "worker",
      `oversize-${length}`,
    );
    expect(response.status, await response.clone().text()).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: "payload-too-large" },
    });
  }
  const journal = (await (await http("/journal")).json()) as {
    events: unknown[];
  };
  expect(journal.events).toHaveLength(1);
});

it("rechecks scoped authority before retries and denies restricted readers across live and archived paths", async () => {
  const { project, http } = await queueApiFixture();
  const store = new CredentialStore(bindings.DB);
  const actor = { principalId: "fixture" };
  const service = await store.createService(
    project,
    { name: "reporter", display_name: "Reporter", role: "participant" },
    actor,
  );
  async function issue(name: string, restricted = false) {
    const token = `tila_${crypto.randomUUID()}${crypto.randomUUID()}`;
    await store.issue(
      {
        projectId: project,
        principalId: service.principal_id,
        name,
        tokenHash: await hashToken(token, bindings.HASH_PEPPER),
        policy: {
          role: "participant",
          capabilities: ["journal:append", "journal:read"],
          ...(restricted ? { restrictions: { task_types: ["issue"] } } : {}),
        },
      },
      actor,
    );
    return (path: string, body?: unknown) =>
      SELF.fetch(`https://worker/projects/${project}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Tila-Participant-Id": "reporter",
          "Idempotency-Key": "scoped",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
  }
  const allowed = await issue("allowed");
  expect((await allowed("/journal", input)).status).toBe(200);
  const restricted = await issue("restricted", true);
  for (const path of [
    "/journal",
    "/journal?event_name=pipeline.tests_passed",
    "/journal/replay?after_seq=0&limit=10",
  ])
    expect((await restricted(path)).status).toBe(403);
  expect((await restricted("/journal", input)).status).toBe(403);
  await store.revoke(project, "allowed", actor);
  expect([401, 403]).toContain((await allowed("/journal", input)).status);
  const current = (await (
    await http("/journal?kind=custom.reported")
  ).json()) as { events: unknown[] };
  expect(current.events).toHaveLength(1);
});

it("checks claim owner and fence through HTTP without changing task or claim state", async () => {
  const { http } = await queueApiFixture();
  expect(
    (
      await http("/tasks", {
        id: "owned",
        type: "issue",
        data: { phase: "todo" },
      })
    ).status,
  ).toBe(200);
  const claimResponse = await http("/claims/acquire", {
    resource: "issue:owned",
    mode: "exclusive",
    ttl_ms: 60_000,
  });
  expect(claimResponse.status, await claimResponse.clone().text()).toBe(200);
  const claim = (await claimResponse.json()) as { fence: number };
  const target = { kind: "claim", resource: "issue:owned", fence: claim.fence };
  const before = await (await http("/tasks/owned")).json();
  const accepted = await http(
    "/journal",
    { ...input, target },
    "worker",
    "claim-bound",
  );
  expect(accepted.status, await accepted.clone().text()).toBe(200);
  expect(
    (await http("/journal", { ...input, target }, "intruder", "claim-bound"))
      .status,
  ).toBe(403);
  expect(
    (
      await http(
        "/journal",
        { ...input, target: { ...target, fence: claim.fence + 1 } },
        "worker",
        "stale",
      )
    ).status,
  ).toBe(409);
  expect(await (await http("/tasks/owned")).json()).toEqual(before);
});
