import { afterEach, describe, expect, it } from "vitest";
import { D1ProjectRegistry } from "../../src/d1/project-registry";
import { RepoAllowlistStore } from "../../src/d1/repo-allowlist";
import { createRestoreRevisionStatements } from "../../src/d1/restore-revisions";
import { createCredentialFixture } from "./helpers/credential-fixture";

describe("D1 restore revision history", () => {
  let f: ReturnType<typeof createCredentialFixture>;
  afterEach(() => f?.sqlite.close());

  function watermark(projectId = "p") {
    return f.sqlite
      .prepare(
        "SELECT revision FROM _project_settings_revision_watermarks WHERE project_id = ?",
      )
      .get(projectId);
  }

  it("seeds the maximum including archived projects and disabled links", () => {
    f = createCredentialFixture(undefined, undefined, undefined, (sqlite) => {
      sqlite.exec(`
        INSERT INTO _projects (project_id, created_at, created_by, cloudflare_account_id, archived, settings_revision)
        VALUES ('p', 0, 'fixture', 'local', 1, 8), ('other', 0, 'fixture', 'local', 0, 30);
        INSERT INTO _project_repos (project_id, github_owner, github_repo, github_repo_id, created_at, created_by, enabled, access_policy_revision, oidc_policy_revision)
        VALUES ('p', 'acme', 'app', 1, 0, 'fixture', 0, 12, 20);
      `);
    });
    expect(watermark()).toEqual({ revision: 20 });
    expect(watermark("other")).toEqual({ revision: 30 });
  });

  it("retains deleted revisions while keeping ordinary policy revisions independent", async () => {
    f = createCredentialFixture();
    const repos = new RepoAllowlistStore(f.db);
    await repos.register({
      projectId: "p",
      githubHost: "github.com",
      githubOwner: "acme",
      githubRepo: "app",
      githubRepoId: 1,
      createdBy: "fixture",
    });
    expect(watermark()).toEqual({ revision: 1 });
    const policy = {
      min_read_permission: "read" as const,
      min_write_permission: "write" as const,
      max_permission: "write" as const,
    };
    await repos.setAccessPolicy("p", "github.com", 1, policy, 1);
    await repos.setAccessPolicy("p", "github.com", 1, policy, 2);
    expect(watermark()).toEqual({ revision: 3 });
    expect(await repos.getOidcPolicy("p", "github.com", 1)).toMatchObject({
      revision: 1,
    });
    const registry = new D1ProjectRegistry(f.db);
    await registry.rename({
      projectId: "p",
      expectedRevision: 1,
      displayName: "App",
      actorPrincipalId: "fixture",
    });
    expect(watermark()).toEqual({ revision: 3 });
    await repos.remove("p", "github.com", 1, 3);
    expect(watermark()).toEqual({ revision: 3 });
    f.sqlite.exec("DELETE FROM _projects WHERE project_id = 'p'");
    expect(watermark()).toEqual({ revision: 3 });
  });

  it("observes a write after restore statements are prepared and rejects its stale revision", async () => {
    f = createCredentialFixture();
    const registry = new D1ProjectRegistry(f.db);
    const restore = createRestoreRevisionStatements(f.db, "p", true);
    const renamed = await registry.rename({
      projectId: "p",
      expectedRevision: 1,
      displayName: "Concurrent",
      actorPrincipalId: "fixture",
    });
    expect(renamed).toMatchObject({ status: "ok", settings: { revision: 2 } });
    await f.db.batch([restore.advance, ...restore.assign]);
    expect(await registry.settings("p")).toMatchObject({ revision: 3 });
    expect(
      await registry.rename({
        projectId: "p",
        expectedRevision: 2,
        displayName: "Stale",
        actorPrincipalId: "fixture",
      }),
    ).toEqual({ status: "conflict", revision: 3 });
    expect(watermark()).toEqual({ revision: 3 });
  });
});
