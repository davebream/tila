import { CREDENTIAL_PRESETS, type CredentialPolicy } from "@tila/schemas";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CredentialDenied,
  CredentialRevisionConflict,
} from "../../src/d1/credential-store";
import { createRestoreRevisionStatements } from "../../src/d1/restore-revisions";
import { createCredentialFixture } from "./helpers/credential-fixture";

let f: ReturnType<typeof createCredentialFixture>;
const actor = { principalId: "bootstrap:test" };
const read = CREDENTIAL_PRESETS["read-only"];
beforeEach(() => {
  f = createCredentialFixture();
});
afterEach(() => {
  vi.restoreAllMocks();
  f.sqlite.close();
});
async function resources() {
  const account = await f.store.createService(
    "p",
    { name: "ci", display_name: "CI", role: "participant" },
    actor,
  );
  const binding = await f.store.createBinding(
    "p",
    account.principal_id,
    {
      name: "ci",
      provider: "oidc",
      issuer: "https://issuer.example",
      subject: "ci",
      policy: read,
    },
    actor,
  );
  return { account, binding };
}
function events(action: string) {
  return f.sqlite
    .prepare("SELECT * FROM _credential_events WHERE action = ?")
    .all(action);
}

it("migrates old rows to revision one without changing identity, policy or revocation", () => {
  const migrated = createCredentialFixture(
    undefined,
    undefined,
    undefined,
    undefined,
    (db) =>
      db.exec(`
    INSERT INTO _service_accounts VALUES ('service:old','p','ci','Old',1,'original',7);
    INSERT INTO _workload_bindings VALUES ('binding','p','service:old','ci','oidc','https://issuer.example','ci','{"role":"viewer","capabilities":["summary:read"]}',1,'original',8);
  `),
  );
  try {
    expect(
      migrated.sqlite
        .prepare(
          "SELECT principal_id, display_name, created_by, revoked_at, revision FROM _service_accounts",
        )
        .get(),
    ).toEqual({
      principal_id: "service:old",
      display_name: "Old",
      created_by: "original",
      revoked_at: 7,
      revision: 1,
    });
    expect(
      migrated.sqlite
        .prepare(
          "SELECT binding_id, policy_json, revoked_at, revision FROM _workload_bindings",
        )
        .get(),
    ).toEqual({
      binding_id: "binding",
      policy_json: '{"role":"viewer","capabilities":["summary:read"]}',
      revoked_at: 8,
      revision: 1,
    });
  } finally {
    migrated.sqlite.close();
  }
});

it("allows exactly one same-revision service writer and audits only the winner", async () => {
  const { account } = await resources();
  expect(account.revision).toBe(1);
  const results = await Promise.allSettled(
    ["First", "Second"].map((name) =>
      f.store.updateService("p", account.principal_id, name, actor, 1),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const loser = results.find((r) => r.status === "rejected");
  expect(loser).toMatchObject({
    reason: { revision: 2, resource: "service-account" },
  });
  expect(events("service-updated")).toHaveLength(1);
  const winner = results.find((r) => r.status === "fulfilled");
  expect(await f.store.listServices("p")).toEqual([
    winner?.status === "fulfilled" ? winner.value : null,
  ]);
  expect(
    await f.store.updateService("p", account.principal_id, "Legacy", actor),
  ).toMatchObject({ revision: 3, display_name: "Legacy" });
});

it("allows exactly one binding writer, keeps omission compatibility and caps the live role", async () => {
  const { account, binding } = await resources();
  const results = await Promise.allSettled(
    [read, CREDENTIAL_PRESETS.worker].map((policy) =>
      f.store.updateBinding(
        "p",
        account.principal_id,
        binding.binding_id,
        policy,
        actor,
        1,
      ),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { revision: 2, resource: "workload-binding" },
  });
  expect(events("workload-policy-updated")).toHaveLength(1);
  f.sqlite
    .prepare(
      "UPDATE _project_memberships SET role = 'viewer' WHERE principal_id = ?",
    )
    .run(account.principal_id);
  expect(
    await f.store.updateBinding(
      "p",
      account.principal_id,
      binding.binding_id,
      CREDENTIAL_PRESETS.worker,
      actor,
    ),
  ).toMatchObject({ revision: 3, policy: { role: "viewer" } });
  expect(
    (await f.store.listBindings("p", account.principal_id))[0].policy
      .capabilities,
  ).not.toContain("tasks:write");
  await expect(
    f.store.updateBinding(
      "p",
      account.principal_id,
      binding.binding_id,
      { role: "owner", capabilities: ["project:destroy"] } as CredentialPolicy,
      actor,
      3,
    ),
  ).rejects.toBeInstanceOf(CredentialDenied);
  expect(events("workload-policy-updated")).toHaveLength(2);
});

it("does not disclose foreign/missing revisions or audit revoked targets", async () => {
  const { account, binding } = await resources();
  for (const project of ["p", "other"]) {
    expect(
      await f.store.updateService(project, "service:missing", "X", actor, 99),
    ).toBeNull();
    expect(
      await f.store.updateBinding(
        project,
        account.principal_id,
        "missing",
        read,
        actor,
        99,
      ),
    ).toBeNull();
  }
  expect(
    await f.store.updateService("other", account.principal_id, "X", actor, 99),
  ).toBeNull();
  expect(
    await f.store.updateBinding(
      "other",
      account.principal_id,
      binding.binding_id,
      read,
      actor,
      99,
    ),
  ).toBeNull();
  await f.store.revokeBinding(
    "p",
    account.principal_id,
    binding.binding_id,
    actor,
  );
  expect(
    await f.store.updateBinding(
      "p",
      account.principal_id,
      binding.binding_id,
      read,
      actor,
      99,
    ),
  ).toBeNull();
  await f.store.revokeService("p", account.principal_id, actor);
  expect(
    await f.store.updateService("p", account.principal_id, "X", actor, 99),
  ).toBeNull();
  expect(events("service-updated")).toHaveLength(0);
  expect(events("workload-policy-updated")).toHaveLength(0);
});

it.each(["account", "binding", "membership", "demotion", "mode"])(
  "rechecks %s authority atomically after policy planning",
  async (change) => {
    const { account, binding } = await resources();
    const batch = f.db.batch.bind(f.db);
    vi.spyOn(f.db, "batch").mockImplementationOnce(async (statements) => {
      if (change === "account")
        f.sqlite
          .prepare(
            "UPDATE _service_accounts SET revoked_at = 1 WHERE principal_id = ?",
          )
          .run(account.principal_id);
      if (change === "binding")
        f.sqlite
          .prepare(
            "UPDATE _workload_bindings SET revoked_at = 1 WHERE binding_id = ?",
          )
          .run(binding.binding_id);
      if (change === "membership")
        f.sqlite
          .prepare(
            "UPDATE _project_memberships SET revoked_at = 1 WHERE principal_id = ?",
          )
          .run(account.principal_id);
      if (change === "mode")
        f.sqlite
          .prepare(
            "UPDATE _projects SET membership_mode = 'github-mirrored' WHERE project_id = 'p'",
          )
          .run();
      if (change === "demotion")
        f.sqlite
          .prepare(
            "UPDATE _project_memberships SET role = 'viewer' WHERE principal_id = ?",
          )
          .run(account.principal_id);
      return batch(statements);
    });
    const update = f.store.updateBinding(
      "p",
      account.principal_id,
      binding.binding_id,
      CREDENTIAL_PRESETS.worker,
      actor,
      1,
    );
    if (change === "account" || change === "binding")
      expect(await update).toBeNull();
    else await expect(update).rejects.toBeInstanceOf(CredentialDenied);
    expect(events("workload-policy-updated")).toHaveLength(0);
    expect(
      (await f.store.listBindings("p", account.principal_id))[0],
    ).toMatchObject({ revision: 1, policy: read });
  },
);

it("rolls back the revision when the audit cannot commit", async () => {
  const { account } = await resources();
  f.sqlite.exec(
    "CREATE TRIGGER reject_audit BEFORE INSERT ON _credential_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
  );
  await expect(
    f.store.updateService("p", account.principal_id, "X", actor, 1),
  ).rejects.toThrow("audit unavailable");
  expect((await f.store.listServices("p"))[0]).toMatchObject({
    revision: 1,
    display_name: "CI",
  });
});

it("restore revisions exceed destination, deleted history and snapshot maxima without ABA", async () => {
  const { account, binding } = await resources();
  const restore = createRestoreRevisionStatements(f.db, "p", false, 40);
  await f.store.updateService(
    "p",
    account.principal_id,
    "Concurrent",
    actor,
    1,
  );
  f.sqlite
    .prepare("UPDATE _workload_bindings SET revision = 50 WHERE binding_id = ?")
    .run(binding.binding_id);
  f.sqlite
    .prepare("DELETE FROM _workload_bindings WHERE binding_id = ?")
    .run(binding.binding_id);
  await f.db.batch([
    restore.advance,
    f.db
      .prepare(
        "INSERT INTO _workload_bindings (binding_id, project_id, principal_id, name, provider, issuer, subject, policy_json, created_at, created_by, revision) VALUES (?, 'p', ?, 'ci', 'oidc', 'https://issuer.example', 'ci', ?, 1, 'fixture', 40)",
      )
      .bind(binding.binding_id, account.principal_id, JSON.stringify(read)),
    ...restore.assign,
  ]);
  expect((await f.store.listServices("p"))[0].revision).toBe(51);
  expect(
    (await f.store.listBindings("p", account.principal_id))[0].revision,
  ).toBe(51);
  for (const stale of [1, 2, 40, 50]) {
    await expect(
      f.store.updateService("p", account.principal_id, "Stale", actor, stale),
    ).rejects.toBeInstanceOf(CredentialRevisionConflict);
    await expect(
      f.store.updateBinding(
        "p",
        account.principal_id,
        binding.binding_id,
        read,
        actor,
        stale,
      ),
    ).rejects.toBeInstanceOf(CredentialRevisionConflict);
  }
  const highSnapshot = createRestoreRevisionStatements(f.db, "p", false, 80);
  await f.db.batch([highSnapshot.advance, ...highSnapshot.assign]);
  expect((await f.store.listServices("p"))[0].revision).toBe(81);
  expect(
    await f.store.updateService(
      "p",
      account.principal_id,
      "Reviewed",
      actor,
      81,
    ),
  ).toMatchObject({ revision: 82 });
});
