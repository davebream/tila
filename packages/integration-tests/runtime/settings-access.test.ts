import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { bindings } from "./setup";

/**
 * Access settings (#298) against the real Worker and D1, from a dashboard
 * cookie session: project rename, repository policy revisions and step-up,
 * the last-owner rule, credential rotation and revocation, and runtime
 * invitation revocation.
 */
const origin = "https://worker";
const project = "access-project";
const password = "test-password-long-enough";

function call(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    credential?: string;
  } = {},
) {
  const { body, credential } = options;
  return SELF.fetch(`${origin}${path}`, {
    method: options.method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Tila-Participant-Id": "dashboard-runtime-test",
      "X-Tila-Client-Name": "dashboard",
      ...(credential?.startsWith("Bearer ")
        ? { Authorization: credential }
        : credential
          ? { Cookie: credential }
          : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function ok<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T;
  expect(response.ok, JSON.stringify(body)).toBe(true);
  return body;
}

async function errorOf(response: Response) {
  return ((await response.json()) as { error: Record<string, unknown> }).error;
}

async function ownerSession() {
  await bindings.DB.prepare(
    `INSERT INTO _projects (project_id,created_at,created_by,cloudflare_account_id) VALUES ('${project}',0,'fixture','local')`,
  ).run();
  const invitation = await ok<{ url: string }>(
    await call("/api/account/setup", {
      body: { email: "owner@example.com", projectId: project },
      credential: "Bearer runtime-test-infra-owner",
    }),
  );
  await ok(
    await call("/api/account/invitations/accept", {
      body: {
        token: new URL(invitation.url).hash.slice(1),
        name: "Owner",
        password,
      },
    }),
  );
  const login = await call("/api/account/auth/sign-in/email", {
    body: { email: "owner@example.com", password },
  });
  await ok(login);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  await ok(
    await call("/api/workspace/select", {
      body: { project_id: project },
      credential: cookie,
    }),
  );
  return cookie;
}

it("renames, revision-checks repository policy and keeps one owner", async () => {
  const cookie = await ownerSession();
  const root = `/projects/${project}`;

  // Project display name: reviewed revision wins, a stale editor conflicts.
  const settings = await ok<{ settings: { revision: number } }>(
    await call(`${root}/project-settings`, { credential: cookie }),
  );
  const renamed = await ok<{
    settings: { display_name: string; revision: number };
  }>(
    await call(`${root}/project-settings`, {
      method: "PATCH",
      body: {
        expected_revision: settings.settings.revision,
        display_name: "Payments",
      },
      credential: cookie,
    }),
  );
  expect(renamed.settings).toMatchObject({ display_name: "Payments" });
  const staleRename = await call(`${root}/project-settings`, {
    method: "PATCH",
    body: {
      expected_revision: settings.settings.revision,
      display_name: "Stale",
    },
    credential: cookie,
  });
  expect(staleRename.status).toBe(412);
  expect(await errorOf(staleRename)).toMatchObject({
    code: "revision-conflict",
    revision: renamed.settings.revision,
  });

  // Repository policy: a link registered earlier (GitHub lookup is out of
  // scope here), then two editors on the same revision.
  await bindings.DB.prepare(
    `INSERT INTO _project_repos (project_id, github_host, github_owner, github_repo, github_repo_id, created_at, created_by)
     VALUES ('${project}', 'github.com', 'acme', 'payments', 4242, 0, 'fixture')`,
  ).run();
  const listed = await ok<{
    repos: Array<{ github_repo_id: number; access_policy_revision: number }>;
  }>(await call("/api/repos", { credential: cookie }));
  expect(listed.repos).toEqual([
    expect.objectContaining({
      github_repo_id: 4242,
      access_policy_revision: 1,
    }),
  ]);
  const policy = {
    min_read_permission: "read",
    min_write_permission: "write",
    max_permission: "write",
    expected_revision: 1,
  };
  const saved = await ok<{ revision: number }>(
    await call("/api/repos/4242/access-policy", {
      method: "PUT",
      body: policy,
      credential: cookie,
    }),
  );
  expect(saved.revision).toBe(2);
  const stalePolicy = await call("/api/repos/4242/access-policy", {
    method: "PUT",
    body: { ...policy, max_permission: "admin" },
    credential: cookie,
  });
  expect(stalePolicy.status).toBe(412);
  expect(await errorOf(stalePolicy)).toMatchObject({
    code: "revision-conflict",
    revision: 2,
  });

  // Last owner: the only owner cannot leave the project.
  const members = await ok<{
    memberships: Array<{ membership_id: string; role: string }>;
  }>(await call(`${root}/memberships`, { credential: cookie }));
  const owner = members.memberships.find((row) => row.role === "owner");
  if (!owner) throw new Error("Owner membership missing");
  const lastOwner = await call(`${root}/memberships/${owner.membership_id}`, {
    method: "DELETE",
    credential: cookie,
  });
  expect(lastOwner.status).toBe(409);
  expect(await errorOf(lastOwner)).toMatchObject({ code: "last-owner" });

  // Repository writes from a stale interactive session need step-up.
  await bindings.DB.prepare(
    "UPDATE _human_sessions SET authenticated_at = 0",
  ).run();
  const stepUp = await call("/api/repos/4242/access-policy", {
    method: "PUT",
    body: { ...policy, expected_revision: 2 },
    credential: cookie,
  });
  expect(stepUp.status).toBe(403);
  expect(await errorOf(stepUp)).toMatchObject({ code: "step-up-required" });
});

it("rotates and revokes credentials and invitations without reviving authority", async () => {
  const cookie = await ownerSession();
  const root = `/projects/${project}`;
  const service = await ok<{ service_account: { principal_id: string } }>(
    await call(`${root}/service-accounts`, {
      body: { name: "ci", display_name: "CI", role: "participant" },
      credential: cookie,
    }),
  );
  const issued = await ok<{ token: string; token_id: string }>(
    await call("/api/tokens", {
      body: {
        name: "ci-reader",
        principal_id: service.service_account.principal_id,
        policy: { role: "viewer", capabilities: ["summary:read"] },
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
      credential: cookie,
    }),
  );
  const summary = (token: string) =>
    call(`${root}/summary`, { credential: `Bearer ${token}` });
  expect((await summary(issued.token)).status).toBe(200);

  const rotated = await ok<{ token: string; token_id: string }>(
    await call("/api/tokens/ci-reader/rotate", {
      body: { expected_token_id: issued.token_id, overlap_seconds: 0 },
      credential: cookie,
    }),
  );
  expect((await summary(issued.token)).status).toBe(401);
  expect((await summary(rotated.token)).status).toBe(200);
  // A stale rotation (old token ID) is refused.
  const staleRotate = await call("/api/tokens/ci-reader/rotate", {
    body: { expected_token_id: issued.token_id, overlap_seconds: 0 },
    credential: cookie,
  });
  expect(staleRotate.ok).toBe(false);
  await staleRotate.arrayBuffer();

  await ok(
    await call("/api/tokens/ci-reader", {
      method: "DELETE",
      credential: cookie,
    }),
  );
  expect((await summary(rotated.token)).status).toBe(401);
  expect((await summary(issued.token)).status).toBe(401);

  // Runtime invitations: listed without secrets, revocable once.
  const invitation = await ok<{ invitation: string; invitation_id: string }>(
    await call(`${root}/runtime/invitations`, {
      body: { name: "build-farm" },
      credential: cookie,
    }),
  );
  const invitations = await call(`${root}/runtime/invitations`, {
    credential: cookie,
  });
  const listedText = await invitations.text();
  expect(invitations.status).toBe(200);
  expect(listedText).not.toContain(invitation.invitation);
  expect(JSON.parse(listedText).invitations).toEqual([
    expect.objectContaining({
      invitation_id: invitation.invitation_id,
      state: "pending",
      enrollments: 0,
    }),
  ]);
  expect(
    await ok<{ revoked: boolean }>(
      await call(
        `${root}/runtime/invitations/${invitation.invitation_id}/revoke`,
        { body: {}, credential: cookie },
      ),
    ),
  ).toMatchObject({ revoked: true });
  const after = await ok<{ invitations: Array<{ state: string }> }>(
    await call(`${root}/runtime/invitations`, { credential: cookie }),
  );
  expect(after.invitations[0].state).toBe("revoked");
});
