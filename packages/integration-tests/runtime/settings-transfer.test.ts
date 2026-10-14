import { SELF } from "cloudflare:test";
import {
  type SettingsReadPort,
  appliedSettingsDefinition,
  createSettingsReceipt,
  exportSettings,
  inspectSettingsDestination,
  planSettingsImport,
  settingsSections,
} from "@tila/core";
import {
  readSettingsFile,
  renderSettingsFile,
} from "@tila/core/definition-yaml";
import { SettingsMappingsSchema, type SettingsReceipt } from "@tila/schemas";
import { TilaClient, createSettingsTransferMethods } from "tila-sdk";
import { expect, it, vi } from "vitest";
import { hashToken } from "../../worker/src/lib/hash-token";
import { bindings } from "./setup";
async function project() {
  const id = `settings-${crypto.randomUUID()}`;
  const token = `fixture-${crypto.randomUUID()}`;
  await bindings.DB.prepare(
    "INSERT INTO _projects (project_id, created_at, created_by, cloudflare_account_id) VALUES (?, 0, 'fixture', 'local')",
  )
    .bind(id)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO _tokens (token_hash, project_id, name, scopes, created_at, created_by) VALUES (?, ?, 'init', 'full', 0, 'fixture')",
  )
    .bind(await hashToken(token, bindings.HASH_PEPPER), id)
    .run();
  const writes: {
    path: string;
    method: string;
    key: string | null;
    body?: unknown;
  }[] = [];
  let loseCreate = false;
  let failGroup = false;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (init?.method !== "GET")
      writes.push({
        path,
        method: init?.method ?? "GET",
        key: new Headers(init?.headers).get("Idempotency-Key"),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
    if (
      failGroup &&
      path.includes("/signals/groups/") &&
      init?.method === "PUT"
    ) {
      failGroup = false;
      return Response.json(
        {
          ok: false,
          error: {
            code: "permission-denied",
            message: "Fixture authority changed",
            retryable: false,
          },
        },
        { status: 403 },
      );
    }
    // workerd supports manual/follow redirects; retain SDK's no-redirect rule.
    const response = await SELF.fetch(String(url), {
      ...init,
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400)
      throw new Error("Unexpected fixture redirect");
    if (
      loseCreate &&
      path.endsWith("/agents") &&
      init?.method === "POST" &&
      response.ok
    ) {
      loseCreate = false;
      throw new Error("Lost response after the real Worker committed");
    }
    return response;
  };
  const client = new TilaClient({
    baseUrl: "https://worker",
    token,
    participantId: "transfer-runtime",
    fetch,
  });
  const methods = createSettingsTransferMethods(client, id);
  const port: SettingsReadPort = {
    ...methods.read,
    definitions: async () =>
      appliedSettingsDefinition(await methods.read.definitions()),
  };
  return {
    id,
    client,
    methods,
    port,
    writes,
    loseCreate: () => {
      loseCreate = true;
    },
    failGroup: () => {
      failGroup = true;
    },
  };
}
it("round-trips mapped settings into a fresh real project, retains partial success and resumes exact actions after reload", async () => {
  const source = await project();
  const destination = await project();
  const sourceIdentity = await source.port.identity();
  const targetIdentity = await destination.port.identity();
  const root = `/projects/${source.id}`;
  await source.client.post(`${root}/schema`, {
    definition:
      "schema_version = 1\n[work_units.task]\nfields = [{name='title',type='string'}]",
    expected_revision: 0,
  });
  await source.client.post(`${root}/agents`, {
    id: "worker",
    name: "Worker",
    bind_policy: [
      { principal_id: sourceIdentity.principal_id, agent_id: "worker" },
    ],
  });
  const room = await source.client.post<{ room: { revision: number } }>(
    `${root}/rooms`,
    { id: "team", name: "Team", delivery_ttl_seconds: 60 },
  );
  const joined = await source.client.put<{ room: { revision: number } }>(
    `${root}/rooms/team/members/agent%3Aworker`,
    { wake: true, expected_revision: room.room.revision },
    { idempotencyKey: crypto.randomUUID() },
  );
  await source.client.put(
    `${root}/rooms/team/members/${encodeURIComponent(`principal:${sourceIdentity.principal_id}`)}`,
    { wake: true, expected_revision: joined.room.revision },
    { idempotencyKey: crypto.randomUUID() },
  );
  await source.client.put(
    `${root}/signals/groups/reviewers`,
    {
      name: "Reviewers",
      principal_ids: [sourceIdentity.principal_id],
      expected_revision: 0,
    },
    { idempotencyKey: crypto.randomUUID() },
  );
  const doc = await exportSettings(source.port, source.id, {
    sections: ["definitions", "agents", "rooms", "signal_groups"],
  });
  const maps = SettingsMappingsSchema.parse({
    identities: {
      [`principal:${sourceIdentity.principal_id}`]: {
        target: targetIdentity.principal_id,
      },
      "agent:worker": { target: "worker-copy" },
    },
    profiles: {},
    resources: {
      agents: { worker: { id: "worker-copy", mode: "create" } },
      rooms: { team: { id: "team-copy", mode: "create" } },
      signal_groups: { reviewers: { id: "reviewers-copy", mode: "create" } },
    },
  });
  for (const format of ["toml", "yaml"] as const)
    expect(
      readSettingsFile(renderSettingsFile(doc, format), { format }),
    ).toEqual({ ok: true, value: doc });
  const snapshot = await inspectSettingsDestination(
    destination.port,
    destination.id,
    settingsSections(doc),
    maps,
  );
  const missing = structuredClone(maps);
  missing.identities = Object.fromEntries(
    Object.entries(missing.identities).filter(
      ([key]) => key !== "agent:worker",
    ),
  );
  expect(
    planSettingsImport(doc, missing, snapshot, crypto.randomUUID()).ok,
  ).toBe(false);
  expect(destination.writes).toHaveLength(0);
  const result = planSettingsImport(doc, maps, snapshot, crypto.randomUUID());
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  let saved: SettingsReceipt | undefined;
  const persist = (r: SettingsReceipt) => {
    saved = structuredClone(r);
  };
  destination.loseCreate();
  const partial = await destination.methods.execute(
    await createSettingsReceipt(result.value),
    persist,
    { confirmRemovals: true },
  );
  expect(partial.actions[0].status).toBe("committed");
  expect(partial.actions[1].status).toBe("uncertain");
  destination.failGroup();
  const retry = await destination.methods.execute(
    JSON.parse(JSON.stringify(saved)),
    persist,
    { confirmRemovals: true },
  );
  expect(retry.actions.at(-1)?.status).toBe("failed");
  expect(
    retry.actions.slice(0, -1).every((r) => r.status === "committed"),
  ).toBe(true);
  const complete = await destination.methods.execute(
    JSON.parse(JSON.stringify(saved)),
    persist,
    { confirmRemovals: true },
  );
  expect(complete.actions.every((r) => r.status === "committed")).toBe(true);
  expect(
    destination.writes.filter((r) => r.path.endsWith("/schema")),
  ).toHaveLength(1);
  expect(
    destination.writes.filter(
      (r) => r.path.includes("/rooms/") && r.path.includes("/members/"),
    ),
  ).toHaveLength(2);
  const copied = await exportSettings(destination.port, destination.id, {
    sections: ["definitions", "agents", "rooms", "signal_groups"],
  });
  expect(copied.definitions).toEqual(doc.definitions);
  expect(copied.settings.agents?.["worker-copy"].bind_policy).toEqual([
    { principal_id: targetIdentity.principal_id, agent_id: "worker-copy" },
  ]);
  expect(copied.settings.rooms?.["team-copy"].members).toEqual(
    expect.arrayContaining([
      { member: "agent:worker-copy", wake: true },
      { member: `principal:${targetIdentity.principal_id}`, wake: true },
    ]),
  );
  expect(
    copied.settings.signal_groups?.["reviewers-copy"].principal_ids,
  ).toEqual([targetIdentity.principal_id]);
});
