import type { CredentialPolicy } from "@tila/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialStore } from "../src/credential-store";
import { createCredentialFixture as fixture } from "./helpers/credential-fixture";

describe("scoped credential lifecycle against migrated SQLite", () => {
  let f: ReturnType<typeof fixture>;
  const actor = { principalId: "bootstrap:test", tokenId: "bootstrap" };
  const policy: CredentialPolicy = {
    role: "participant",
    capabilities: ["records:read", "records:write"],
    restrictions: { records: [{ type: "config", key_prefixes: ["team/a"] }] },
  };
  beforeEach(() => {
    f = fixture();
  });
  afterEach(() => {
    f.sqlite.close();
    vi.useRealTimers();
  });
  async function issue() {
    const service = await f.store.createService(
      "p",
      { name: "integration", display_name: "Integration", role: "participant" },
      actor,
    );
    return f.store.issue(
      {
        projectId: "p",
        principalId: service.principal_id,
        name: "key",
        policy,
        tokenHash: "secret-hash",
      },
      actor,
    );
  }
  it("preserves principal and scope across rotation and rejects stale compare-and-swap", async () => {
    const key = await issue();
    const rotated = await f.store.rotate(
      "p",
      "key",
      key.token_id,
      "replacement-hash",
      0,
      actor,
    );
    expect(rotated.principal_id).toBe(key.principal_id);
    expect(await f.store.resolve(key.token_id)).toBeNull();
    expect((await f.store.resolve(rotated.token_id))?.policy).toEqual(policy);
    await expect(
      f.store.rotate("p", "key", key.token_id, "loser-hash", 0, actor),
    ).rejects.toThrow("version changed");
    expect(await f.legacy.validate("loser-hash")).toBeNull();
    expect(
      f.sqlite.prepare("SELECT count(*) AS n FROM _credential_versions").get(),
    ).toEqual({ n: 2 });
  });
  it("overlap ends on time and revocation rejects every version from a fresh store", async () => {
    vi.useFakeTimers();
    const key = await issue();
    const rotated = await f.store.rotate(
      "p",
      "key",
      key.token_id,
      "replacement-hash",
      10,
      actor,
    );
    expect(await f.store.resolve(key.token_id)).not.toBeNull();
    vi.advanceTimersByTime(10_000);
    expect(await f.store.resolve(key.token_id)).toBeNull();
    const other = new CredentialStore(f.db);
    expect(await other.resolve(rotated.token_id)).not.toBeNull();
    await f.store.revoke("p", "key", actor);
    expect(await other.resolve(rotated.token_id)).toBeNull();
    expect(await f.legacy.validate("replacement-hash")).toBeNull();
  });
  it("membership demotion removes write grants immediately", async () => {
    const key = await issue();
    f.sqlite
      .prepare(
        "UPDATE _project_memberships SET role = 'viewer' WHERE principal_id = ?",
      )
      .run(key.principal_id);
    expect((await f.store.resolve(key.token_id))?.policy.capabilities).toEqual([
      "records:read",
    ]);
    f.sqlite
      .prepare(
        "UPDATE _project_memberships SET revoked_at = 1 WHERE principal_id = ?",
      )
      .run(key.principal_id);
    expect(await f.store.resolve(key.token_id)).toBeNull();
  });
  it("never exposes hashes or secrets in listing or audit, and expires on the boundary", async () => {
    vi.useFakeTimers();
    const key = await issue();
    const list = JSON.stringify(await f.store.list("p"));
    expect(list).not.toContain("secret-hash");
    expect(list).not.toContain("token_hash");
    expect(
      JSON.stringify(
        f.sqlite.prepare("SELECT * FROM _credential_events").all(),
      ),
    ).not.toContain("secret-hash");
    vi.setSystemTime(Number(key.expires_at) * 1000);
    expect(await f.store.resolve(key.token_id)).toBeNull();
  });
  it("revokes a service atomically but preserves the last owner", async () => {
    const key = await issue();
    await f.store.revokeService("p", key.principal_id, actor);
    expect(await f.store.resolve(key.token_id)).toBeNull();
    const owner = await f.store.createService(
      "p",
      { name: "owner", display_name: "Owner", role: "owner" },
      actor,
    );
    await expect(
      f.store.revokeService("p", owner.principal_id, actor),
    ).rejects.toThrow("last project owner");
    expect(
      (await f.store.listServices("p")).find(
        (s) => s.principal_id === owner.principal_id,
      )?.revoked_at,
    ).toBeNull();
  });
  it("enforces logical name uniqueness with legacy credentials", async () => {
    await issue();
    await expect(
      f.legacy.issue({
        projectId: "p",
        name: "key",
        tokenHash: "legacy",
        createdBy: "owner",
        createdAt: 1,
      }),
    ).rejects.toThrow();
    await f.legacy.issue({
      projectId: "p",
      name: "old",
      tokenHash: "legacy",
      createdBy: "owner",
      createdAt: 1,
    });
    const service = (await f.store.listServices("p"))[0];
    await expect(
      f.store.issue(
        {
          projectId: "p",
          principalId: service.principal_id,
          name: "old",
          policy,
          tokenHash: "new",
        },
        actor,
      ),
    ).rejects.toThrow();
  });
  it("snapshots the membership ceiling so later promotion cannot expand an issued key", async () => {
    const service = await f.store.createService(
      "p",
      { name: "viewer", display_name: "Viewer", role: "viewer" },
      actor,
    );
    const key = await f.store.issue(
      {
        projectId: "p",
        principalId: service.principal_id,
        name: "viewer-key",
        policy,
        tokenHash: "viewer-hash",
      },
      actor,
    );
    expect(key.policy.role).toBe("viewer");
    f.sqlite
      .prepare(
        "UPDATE _project_memberships SET role = 'owner' WHERE principal_id = ?",
      )
      .run(service.principal_id);
    expect((await f.store.resolve(key.token_id))?.policy.capabilities).toEqual([
      "records:read",
    ]);
  });
  it("intersects binding policy updates and consumes assertions even after logical revocation", async () => {
    const key = await issue();
    const binding = await f.store.createBinding(
      "p",
      key.principal_id,
      {
        name: "ci",
        provider: "oidc",
        issuer: "https://issuer.example",
        subject: "runner",
        policy,
      },
      actor,
    );
    const workload = await f.store.issue(
      {
        projectId: "p",
        principalId: key.principal_id,
        name: "assertion-1",
        policy,
        tokenHash: "workload-hash",
        workloadBindingId: binding.binding_id,
      },
      actor,
    );
    await f.store.updateBinding(
      "p",
      key.principal_id,
      binding.binding_id,
      {
        role: "viewer",
        capabilities: ["records:read"],
        restrictions: {
          records: [{ type: "config", key_prefixes: ["team/a/child"] }],
        },
      },
      actor,
    );
    expect((await f.store.resolve(workload.token_id))?.policy).toEqual({
      role: "viewer",
      capabilities: ["records:read"],
      restrictions: {
        records: [{ type: "config", key_prefixes: ["team/a/child"] }],
      },
    });
    await f.store.updateBinding(
      "p",
      key.principal_id,
      binding.binding_id,
      {
        role: "participant",
        capabilities: ["records:read", "records:write", "records:delete"],
      },
      actor,
    );
    expect(
      (await f.store.resolve(workload.token_id))?.policy.capabilities,
    ).not.toContain("records:delete");
    await f.store.revoke("p", "assertion-1", actor);
    expect(await f.store.hasWorkloadExchange("p", "assertion-1")).toBe(true);
    await expect(
      f.store.issue(
        {
          projectId: "p",
          principalId: key.principal_id,
          name: "assertion-1",
          policy,
          tokenHash: "replay-hash",
          workloadBindingId: binding.binding_id,
        },
        actor,
      ),
    ).rejects.toThrow();
    expect(await f.legacy.validate("replay-hash")).toBeNull();
  });
  it("preserves earlier overlap deadlines and DPoP binding across repeated rotations", async () => {
    vi.useFakeTimers();
    const key = await issue();
    f.sqlite
      .prepare("UPDATE _tokens SET cnf_jkt = ? WHERE token_id = ?")
      .run("a".repeat(43), key.token_id);
    const second = await f.store.rotate(
      "p",
      "key",
      key.token_id,
      "second",
      5,
      actor,
    );
    vi.advanceTimersByTime(1000);
    await f.store.rotate("p", "key", second.token_id, "third", 60, actor);
    vi.advanceTimersByTime(4000);
    expect(await f.store.resolve(key.token_id)).toBeNull();
    expect((await f.legacy.validate("third"))?.cnfJkt).toBe("a".repeat(43));
    expect(await f.store.resolve(second.token_id)).not.toBeNull();
  });
  it("migration retains existing token IDs, hashes, memberships and attribution", async () => {
    const migrated = fixture((db) => {
      db.prepare(
        "INSERT INTO _projects (project_id, created_at, created_by, cloudflare_account_id) VALUES ('p', 0, 'original-actor', 'cf')",
      ).run();
      db.prepare(
        "INSERT INTO _tokens (token_hash, token_id, project_id, name, scopes, created_at, created_by) VALUES ('historical-hash', 'historical-id', 'p', 'old-key', 'full', 123, 'original-actor')",
      ).run();
      db.prepare(
        "INSERT INTO _project_memberships (membership_id, project_id, principal_id, provider, identity_host, subject_id, subject_kind, role, granted_by, granted_at) VALUES ('membership', 'p', 'github:github.com:42', 'github', 'github.com', '42', 'human', 'owner', 'original-granter', 123)",
      ).run();
    });
    try {
      expect(await migrated.legacy.validate("historical-hash")).toMatchObject({
        tokenId: "historical-id",
        scopes: "full",
      });
      expect(
        migrated.sqlite
          .prepare(
            "SELECT granted_by, role FROM _project_memberships WHERE membership_id = 'membership'",
          )
          .get(),
      ).toEqual({ granted_by: "original-granter", role: "owner" });
      expect((await migrated.legacy.list("p"))[0].created_by).toBe(
        "original-actor",
      );
    } finally {
      migrated.sqlite.close();
    }
  });
  it("revokes all old versions before restore can reactivate binding metadata", async () => {
    const key = await issue();
    await f.store.revokeProjectCredentials("p", actor);
    expect(await f.store.resolve(key.token_id)).toBeNull();
    expect(await f.legacy.validate("secret-hash")).toBeNull();
  });
  it("issues exactly one secret version when rotations race", async () => {
    const key = await issue();
    const results = await Promise.allSettled([
      f.store.rotate("p", "key", key.token_id, "race-one", 0, actor),
      f.store.rotate("p", "key", key.token_id, "race-two", 0, actor),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      f.sqlite.prepare("SELECT count(*) AS n FROM _credential_versions").get(),
    ).toEqual({ n: 2 });
  });
});

it("migration 0029 preserves existing membership and credential rows without inventing workload context", () => {
  const f = fixture(undefined, (sqlite) => {
    sqlite.exec(`
      INSERT INTO _project_memberships (membership_id, project_id, principal_id, provider, identity_host, subject_id, subject_kind, role, granted_by, granted_at)
      VALUES ('membership', 'p', 'github:github.com:7', 'github', 'github.com', '7', 'human', 'owner', 'bootstrap', 1);
      INSERT INTO _credentials (credential_id, project_id, principal_id, name, policy_json, current_token_id, created_at, created_by, workload_binding_id)
      VALUES ('credential', 'p', 'service:old', 'old-workload', '{"role":"viewer","capabilities":["tasks:read"]}', 'token', 1, 'bootstrap', 'binding');
    `);
  });
  try {
    expect(
      f.sqlite
        .prepare(
          "SELECT role, principal_id FROM _project_memberships WHERE membership_id='membership'",
        )
        .get(),
    ).toEqual({ role: "owner", principal_id: "github:github.com:7" });
    expect(
      f.sqlite
        .prepare(
          "SELECT current_token_id, workload_binding_id, workload_context_json FROM _credentials WHERE credential_id='credential'",
        )
        .get(),
    ).toEqual({
      current_token_id: "token",
      workload_binding_id: "binding",
      workload_context_json: null,
    });
  } finally {
    f.sqlite.close();
  }
});
