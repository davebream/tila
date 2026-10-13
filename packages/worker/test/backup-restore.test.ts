import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { D1ProjectRegistry } from "../src/d1/project-registry";
import { RepoAllowlistStore } from "../src/d1/repo-allowlist";
import { createBackupRoutes } from "../src/routes/backup";
import type { Env, HonoVariables } from "../src/types";
import { createCredentialFixture } from "./d1/helpers/credential-fixture";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

describe("D1 restore revisions", () => {
  let f: ReturnType<typeof createCredentialFixture>;
  beforeEach(() => {
    f = createCredentialFixture();
    f.sqlite.exec(`
      UPDATE _projects SET display_name = 'Current', settings_revision = 9 WHERE project_id = 'p';
      INSERT INTO _project_repos (project_id, github_owner, github_repo, github_repo_id, created_at, created_by, access_policy_revision, oidc_policy_revision)
      VALUES ('p', 'acme', 'app', 7, 0, 'fixture', 12, 20);
      INSERT INTO _projects (project_id, display_name, created_at, created_by, cloudflare_account_id, settings_revision)
      VALUES ('other', 'Untouched', 0, 'fixture', 'cf', 80);
    `);
  });
  afterEach(() => f.sqlite.close());

  const legacySections = () => ({
    _projects: [{ project_id: "source", display_name: "Restored" }],
    _project_repos: [
      {
        project_id: "source",
        github_host: "github.com",
        github_owner: "acme",
        github_repo: "app",
        github_repo_id: 7,
        created_at: 0,
        created_by: "fixture",
      },
    ],
  });

  function restore(
    sections: Record<string, Record<string, unknown>[]>,
    projectTokenAuth = false,
    mode: "import" | "rollback" = "import",
  ) {
    const app = new Hono<AppEnv>();
    app.onError(() =>
      Response.json({ error: "restore-failed" }, { status: 500 }),
    );
    app.use("/*", async (c, next) => {
      c.set("projectId", "p");
      c.set("tokenResult", {
        kind: "d1-token",
        projectId: "p",
        name: "owner",
        tokenId: "owner",
        scopes: "full",
      });
      c.set("doStub", {
        fetch: async () =>
          Response.json({
            state: {
              session_id: "restore",
              mode,
              owner: projectTokenAuth ? "token:owner" : "infra",
            },
          }),
      } as unknown as DurableObjectStub);
      await next();
    });
    app.route("/", createBackupRoutes({ projectTokenAuth }));
    return app.request(
      "/d1/restore",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Confirm-Slug": "p" },
        body: JSON.stringify({ sessionId: "restore", sections }),
      },
      { DB: f.db } as Env,
    );
  }

  function state() {
    return {
      project: f.sqlite
        .prepare(
          "SELECT display_name, settings_revision FROM _projects WHERE project_id = 'p'",
        )
        .get(),
      repo: f.sqlite
        .prepare("SELECT * FROM _project_repos WHERE project_id = 'p'")
        .get(),
      watermark: f.sqlite
        .prepare(
          "SELECT revision FROM _project_settings_revision_watermarks WHERE project_id = 'p'",
        )
        .get(),
    };
  }

  it.each([
    [false, "import"],
    [false, "rollback"],
    [true, "import"],
    [true, "rollback"],
  ] as const)(
    "restores pre-0034 backups (project auth %s, %s)",
    async (projectAuth, mode) => {
      expect((await restore(legacySections(), projectAuth, mode)).status).toBe(
        200,
      );
      expect(state()).toMatchObject({
        project: { display_name: "Restored", settings_revision: 21 },
        repo: {
          access_policy_revision: 21,
          oidc_policy_revision: 21,
          oidc_enabled: 0,
        },
        watermark: { revision: 21 },
      });
      const repos = new RepoAllowlistStore(f.db);
      expect(
        await repos.setAccessPolicy(
          "p",
          "github.com",
          7,
          {
            min_read_permission: "read",
            min_write_permission: "write",
            max_permission: "admin",
          },
          12,
        ),
      ).toEqual({ status: "conflict", revision: 21 });
      expect(
        await repos.setOidcPolicy(
          "p",
          "github.com",
          7,
          {
            enabled: false,
            max_permission: "read",
            subject_pattern: null,
            allowed_events: [],
            allowed_refs: [],
            allowed_environments: [],
            allowed_workflows: [],
          },
          20,
        ),
      ).toEqual({ status: "conflict", revision: 21 });
      expect(
        await new D1ProjectRegistry(f.db).rename({
          projectId: "p",
          expectedRevision: 9,
          displayName: "Stale",
          actorPrincipalId: "fixture",
        }),
      ).toEqual({ status: "conflict", revision: 21 });
      expect(
        f.sqlite
          .prepare(
            "SELECT display_name, settings_revision FROM _projects WHERE project_id = 'other'",
          )
          .get(),
      ).toEqual({ display_name: "Untouched", settings_revision: 80 });
    },
  );

  it("ignores imported revision history and advances on repeated restores", async () => {
    const sections = {
      _projects: [{ ...legacySections()._projects[0], settings_revision: 900 }],
      _project_repos: [
        {
          ...legacySections()._project_repos[0],
          access_policy_revision: 800,
          oidc_policy_revision: 700,
        },
      ],
      _project_settings_revision_watermarks: [
        { project_id: "p", revision: 1000 },
      ],
    };
    expect((await restore(sections)).status).toBe(200);
    expect(state().watermark).toEqual({ revision: 21 });
    expect((await restore(sections)).status).toBe(200);
    expect(state()).toMatchObject({
      project: { settings_revision: 22 },
      repo: { access_policy_revision: 22, oidc_policy_revision: 22 },
    });
  });

  it("remembers a deleted link across empty restores and leaves omitted project settings alone", async () => {
    f.sqlite.exec("DELETE FROM _project_repos WHERE project_id = 'p'");
    expect((await restore({ _project_repos: [] })).status).toBe(200);
    expect(state()).toMatchObject({
      project: { display_name: "Current", settings_revision: 9 },
      repo: undefined,
      watermark: { revision: 21 },
    });
    expect((await restore(legacySections())).status).toBe(200);
    expect(state()).toMatchObject({
      repo: { access_policy_revision: 22, oidc_policy_revision: 22 },
    });
  });

  it("rolls back row replacement and revision history on import failure", async () => {
    const previous = state();
    const sections = legacySections();
    sections._project_repos.push({ ...sections._project_repos[0] });
    expect((await restore(sections)).status).toBe(500);
    expect(state()).toEqual(previous);
  });
});
