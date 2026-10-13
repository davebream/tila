import { CREDENTIAL_PRESETS } from "@tila/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectMembershipStore } from "../../src/d1/project-memberships";
import { D1ProjectRegistry } from "../../src/d1/project-registry";
import { RepoAllowlistStore } from "../../src/d1/repo-allowlist";
import { RuntimeStore } from "../../src/d1/runtime-store";
import { createCredentialFixture } from "./helpers/credential-fixture";

describe("access settings on the migrated D1 schema", () => {
  let f: ReturnType<typeof createCredentialFixture>;
  beforeEach(() => {
    f = createCredentialFixture();
  });
  afterEach(() => f.sqlite.close());

  async function owners(...ids: number[]) {
    const store = new ProjectMembershipStore(f.db);
    const rows = [];
    for (const id of ids)
      rows.push(
        (
          await store.grant({
            projectId: "p",
            principal: { provider: "github", host: "github.com", user_id: id },
            subjectKind: "human",
            role: "owner",
            actorPrincipalId: "bootstrap",
          })
        ).membership,
      );
    return { store, rows };
  }
  const activeOwners = () =>
    (
      f.sqlite
        .prepare(
          "SELECT count(*) AS n FROM _project_memberships WHERE project_id = 'p' AND role = 'owner' AND revoked_at IS NULL",
        )
        .get() as { n: number }
    ).n;

  it("never lets concurrent removals revoke the last two owners", async () => {
    const { store, rows } = await owners(1, 2);
    const results = await Promise.all(
      rows.map((row) =>
        store.revoke({
          projectId: "p",
          membershipId: row.membership_id,
          actorPrincipalId: "github:github.com:1",
        }),
      ),
    );
    expect(results.filter((r) => r && "status" in r)).toEqual([
      { status: "last-owner" },
    ]);
    expect(activeOwners()).toBe(1);
    // The refused revocation left no subject tombstone or audit event.
    expect(
      f.sqlite.prepare("SELECT count(*) AS n FROM _revoked_subjects").get(),
    ).toEqual({ n: 1 });
    expect(
      f.sqlite
        .prepare(
          "SELECT count(*) AS n FROM _membership_events WHERE action = 'revoke'",
        )
        .get(),
    ).toEqual({ n: 1 });
  });

  it("refuses to demote the last owner but lets the bootstrap credential", async () => {
    const { store, rows } = await owners(1);
    const [only] = rows;
    expect(
      await store.updateRole({
        projectId: "p",
        membershipId: only.membership_id,
        role: "maintainer",
        actorPrincipalId: "github:github.com:1",
      }),
    ).toEqual({ status: "last-owner" });
    expect(
      f.sqlite
        .prepare(
          "SELECT count(*) AS n FROM _membership_events WHERE action = 'role-change'",
        )
        .get(),
    ).toEqual({ n: 0 });
    const demoted = await store.updateRole({
      projectId: "p",
      membershipId: only.membership_id,
      role: "maintainer",
      actorPrincipalId: "bootstrap",
      allowLastOwner: true,
    });
    expect(demoted).toMatchObject({ role: "maintainer" });
  });

  it("checks repository policy revisions in the write", async () => {
    const repos = new RepoAllowlistStore(f.db);
    await repos.register({
      projectId: "p",
      githubHost: "github.com",
      githubOwner: "o",
      githubRepo: "r",
      githubRepoId: 7,
      createdBy: "owner",
    });
    const policy = {
      min_read_permission: "read" as const,
      min_write_permission: "write" as const,
      max_permission: "write" as const,
    };
    const first = await repos.setAccessPolicy("p", "github.com", 7, policy, 1);
    expect(first).toMatchObject({ status: "ok", revision: 2 });
    expect(
      await repos.setAccessPolicy("p", "github.com", 7, policy, 1),
    ).toEqual({ status: "conflict", revision: 2 });
    // OIDC policy has its own revision.
    const oidc = await repos.setOidcPolicy(
      "p",
      "github.com",
      7,
      {
        enabled: true,
        max_permission: "read",
        subject_pattern: null,
        allowed_events: ["push"],
        allowed_refs: [],
        allowed_environments: [],
        allowed_workflows: [],
      },
      1,
    );
    expect(oidc).toMatchObject({ status: "ok", revision: 2 });
    expect((await repos.listLinks("p"))[0]).toMatchObject({
      github_repo_id: 7,
      access_policy_revision: 2,
      oidc_policy_revision: 2,
      access_policy: { min_read_permission: "read" },
    });
    expect(await repos.listLinks("p", "github.example.com")).toEqual([]);
    expect(await repos.remove("p", "github.com", 7, 1)).toEqual({
      status: "conflict",
      revision: 2,
    });
    expect(await repos.remove("p", "github.com", 7, 2)).toEqual({
      status: "removed",
    });
  });

  it("renames against the reviewed revision and audits only a change", async () => {
    const registry = new D1ProjectRegistry(f.db);
    const settings = await registry.settings("p");
    expect(settings).toMatchObject({ project_id: "p", revision: 1 });
    expect(
      await registry.rename({
        projectId: "p",
        expectedRevision: 1,
        displayName: "Payments",
        actorPrincipalId: "github:github.com:1",
      }),
    ).toMatchObject({
      status: "ok",
      settings: { display_name: "Payments", revision: 2 },
    });
    expect(
      await registry.rename({
        projectId: "p",
        expectedRevision: 1,
        displayName: "Stale",
        actorPrincipalId: "github:github.com:2",
      }),
    ).toEqual({ status: "conflict", revision: 2 });
    expect(
      f.sqlite
        .prepare(
          "SELECT count(*) AS n FROM _membership_events WHERE action = 'project-rename'",
        )
        .get(),
    ).toEqual({ n: 1 });
  });

  it("lists invitations without secrets and refuses revoked redemption", async () => {
    let now = 1000;
    const runtime = new RuntimeStore(f.db, () => now);
    const created = await runtime.invite(
      "p",
      "github:github.com:1",
      "CI",
      CREDENTIAL_PRESETS.worker,
      "invitation-hash",
    );
    const [listed] = await runtime.listInvitations("p");
    expect(listed).toMatchObject({
      invitation_id: created.invitation_id,
      name: "CI",
      state: "pending",
      enrollments: 0,
    });
    expect(JSON.stringify(listed)).not.toContain("invitation-hash");
    expect(
      await runtime.revokeInvitation(
        "p",
        created.invitation_id,
        "github:github.com:1",
      ),
    ).toBe("revoked");
    expect(
      await runtime.revokeInvitation(
        "p",
        created.invitation_id,
        "github:github.com:1",
      ),
    ).toBe("already-revoked");
    expect(
      await runtime.revokeInvitation("p", "missing", "github:github.com:1"),
    ).toBe("not-found");
    expect((await runtime.listInvitations("p"))[0].state).toBe("revoked");
    await expect(
      runtime.enroll(
        "p",
        {
          operation_id: crypto.randomUUID(),
          installation_id: crypto.randomUUID(),
          name: "Runner",
          jkt: "a".repeat(43),
        },
        null,
        CREDENTIAL_PRESETS.worker,
        { id: crypto.randomUUID(), hash: crypto.randomUUID() },
        "invitation-hash",
      ),
    ).rejects.toMatchObject({ code: "invitation-invalid" });
    now = 10_000_000;
    const later = await runtime.invite(
      "p",
      "github:github.com:1",
      "Old",
      CREDENTIAL_PRESETS.worker,
      "another-hash",
    );
    now += 10 ** 9;
    expect(
      (await runtime.listInvitations("p")).find(
        (row) => row.invitation_id === later.invitation_id,
      )?.state,
    ).toBe("expired");
  });
});
