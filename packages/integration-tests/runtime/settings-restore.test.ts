import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { D1TokenStore, RepoAllowlistStore } from "../../worker/src/d1";
import { hashToken } from "../../worker/src/lib/hash-token";
import { bindings } from "./setup";

it.each(["import", "rollback"] as const)(
  "rejects stale settings after project backup %s",
  async (mode) => {
    const project = "settings-restore";
    const root = `/projects/${project}`;
    await bindings.DB.prepare(
      "INSERT INTO _projects (project_id, display_name, created_at, created_by, cloudflare_account_id) VALUES (?, 'Backup name', 0, 'fixture', 'local')",
    )
      .bind(project)
      .run();
    let token = `tila_${crypto.randomUUID()}${crypto.randomUUID()}`;
    await new D1TokenStore(bindings.DB).issue({
      projectId: project,
      tokenHash: await hashToken(token, bindings.HASH_PEPPER),
      name: "owner",
      createdBy: "fixture",
      createdAt: 0,
    });
    await new RepoAllowlistStore(bindings.DB).register({
      projectId: project,
      githubHost: "github.com",
      githubOwner: "acme",
      githubRepo: "app",
      githubRepoId: 7,
      createdBy: "fixture",
    });

    const backupRoot = `${root}/admin/backup`;
    const backupToken = token;
    function call(
      path: string,
      method = "GET",
      body?: unknown,
      credential = token,
    ) {
      return SELF.fetch(`https://worker${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${credential}`,
          "Content-Type": "application/json",
          "X-Confirm-Slug": project,
          "X-Tila-Participant-Id": "restore-test",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }
    async function ok<T>(response: Response): Promise<T> {
      const body = (await response.json()) as T;
      expect(response.ok, JSON.stringify(body)).toBe(true);
      return body;
    }
    const backup = (path: string, method = "GET", body?: unknown) =>
      call(`${backupRoot}${path}`, method, body, backupToken);

    await ok(
      await backup("/transfer/begin", "POST", {
        sessionId: "export",
        mode: "export",
      }),
    );
    const exported = await ok<{
      sections: Record<string, Record<string, unknown>[]>;
    }>(await backup("/d1?sessionId=export"));
    const meta = await ok<{
      digest: string;
      migrationVersion: number;
      journal: { nextSequence: number };
    }>(await backup("/transfer/meta?sessionId=export"));
    expect(
      exported.sections._project_settings_revision_watermarks,
    ).toBeUndefined();
    expect(exported.sections._projects[0]).not.toHaveProperty(
      "settings_revision",
    );
    expect(exported.sections._project_repos[0]).not.toHaveProperty(
      "access_policy_revision",
    );
    expect(exported.sections._project_repos[0]).not.toHaveProperty(
      "oidc_policy_revision",
    );
    await ok(
      await backup("/transfer/complete-export", "POST", {
        sessionId: "export",
      }),
    );

    const projectBefore = await ok<{ settings: { revision: number } }>(
      await call(`${root}/project-settings`),
    );
    const accessBefore = await ok<{ revision: number }>(
      await call("/api/repos/7/access-policy"),
    );
    const oidcBefore = await ok<{ revision: number }>(
      await call("/api/repos/7/oidc-policy"),
    );
    const accessPolicy = {
      min_read_permission: "read",
      min_write_permission: "write",
      max_permission: "admin",
    };
    const oidcPolicy = {
      enabled: true,
      max_permission: "read",
      subject_pattern: null,
      allowed_events: ["push"],
      allowed_refs: [],
      allowed_environments: [],
      allowed_workflows: [],
    };
    const renamed = await ok<{ settings: { revision: number } }>(
      await call(`${root}/project-settings`, "PATCH", {
        display_name: "Before restore",
        expected_revision: projectBefore.settings.revision,
      }),
    );
    const access = await ok<{ revision: number }>(
      await call("/api/repos/7/access-policy", "PUT", {
        ...accessPolicy,
        expected_revision: accessBefore.revision,
      }),
    );
    const oidc = await ok<{ revision: number }>(
      await call("/api/repos/7/oidc-policy", "PUT", {
        ...oidcPolicy,
        expected_revision: oidcBefore.revision,
      }),
    );
    await ok(
      await backup("/transfer/begin", "POST", { sessionId: "restore", mode }),
    );
    const restored = await ok<{ bootstrapToken: string }>(
      await backup("/d1/restore", "POST", {
        sessionId: "restore",
        sections: exported.sections,
        createBootstrapToken: true,
      }),
    );
    await ok(
      await backup("/transfer/finalize", "POST", {
        sessionId: "restore",
        journalNextSequence: meta.journal.nextSequence,
        semanticDigest: meta.digest,
        migrationVersion: meta.migrationVersion,
      }),
    );
    // Use the new bootstrap credential so revocation cannot mask a revision bug.
    token = restored.bootstrapToken;
    expect(token).toBeTruthy();
    const restoredProject = await ok<{
      settings: { revision: number; display_name: string };
    }>(await call(`${root}/project-settings`));
    const restoredAccess = await ok<{
      revision: number;
      policy: { max_permission: string };
    }>(await call("/api/repos/7/access-policy"));
    const restoredOidc = await ok<{
      revision: number;
      policy: { enabled: boolean };
    }>(await call("/api/repos/7/oidc-policy"));
    expect(restoredProject.settings.display_name).toBe("Backup name");
    expect(restoredAccess.policy.max_permission).toBe("write");
    expect(restoredOidc.policy.enabled).toBe(false);

    const edits = [
      {
        path: `${root}/project-settings`,
        method: "PATCH",
        body: { display_name: "Editor name" },
        stale: [projectBefore.settings.revision, renamed.settings.revision],
        current: restoredProject.settings.revision,
      },
      {
        path: "/api/repos/7/access-policy",
        method: "PUT",
        body: accessPolicy,
        stale: [accessBefore.revision, access.revision],
        current: restoredAccess.revision,
      },
      {
        path: "/api/repos/7/oidc-policy",
        method: "PUT",
        body: oidcPolicy,
        stale: [oidcBefore.revision, oidc.revision],
        current: restoredOidc.revision,
      },
    ];
    for (const edit of edits) {
      for (const expected_revision of edit.stale) {
        expect(edit.current).toBeGreaterThan(expected_revision);
        const response = await call(edit.path, edit.method, {
          ...edit.body,
          expected_revision,
        });
        expect(response.status).toBe(412);
        expect(await response.json()).toMatchObject({
          error: { code: "revision-conflict", revision: edit.current },
        });
      }
    }
    expect(await ok(await call(`${root}/project-settings`))).toEqual(
      restoredProject,
    );
    expect(await ok(await call("/api/repos/7/access-policy"))).toEqual(
      restoredAccess,
    );
    expect(await ok(await call("/api/repos/7/oidc-policy"))).toEqual(
      restoredOidc,
    );
    for (const edit of edits) {
      await ok(
        await call(edit.path, edit.method, {
          ...edit.body,
          expected_revision: edit.current,
        }),
      );
    }
  },
);
