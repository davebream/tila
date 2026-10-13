import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { D1SessionStore, D1TokenStore } from "../../worker/src/d1";
import { hashToken } from "../../worker/src/lib/hash-token";
import { bindings } from "./setup";

const origin = "https://worker";
const password = "test-password-long-enough";
async function request(
  path: string,
  body?: unknown,
  credential?: string,
  method = body === undefined ? "GET" : "POST",
) {
  return SELF.fetch(`${origin}${path}`, {
    method,
    headers: {
      "X-Tila-Participant-Id": "human-runtime-test",
      Origin: origin,
      "Content-Type": "application/json",
      ...(credential?.startsWith("Bearer ")
        ? { Authorization: credential }
        : credential
          ? { Cookie: credential }
          : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
interface AccountFixtureResponse {
  url: string;
  token: string;
  sessionId: string;
  access_token: string;
  device_code: string;
  user_code: string;
  user: { id: string; role: string };
  capabilities: { memberships_manage: boolean; auth_method: string };
  projects: { projectId: string; role: string }[];
  tokens: { principal_id: string }[];
}
async function json(response: Response) {
  const body = (await response.json()) as AccountFixtureResponse;
  expect(response.ok, JSON.stringify(body)).toBe(true);
  return body;
}
async function setup(beforeInvitation?: () => Promise<void>) {
  await bindings.DB.prepare(
    "INSERT INTO _projects (project_id,created_at,created_by,cloudflare_account_id) VALUES ('human-project',0,'fixture','local')",
  ).run();
  await beforeInvitation?.();
  const invitation = await json(
    await request(
      "/api/account/setup",
      { email: "owner@example.com", projectId: "human-project" },
      "Bearer runtime-test-infra-owner",
    ),
  );
  const token = new URL(invitation.url).hash.slice(1);
  await json(
    await request("/api/account/invitations/accept", {
      token,
      name: "Owner",
      password,
    }),
  );
  const login = await request("/api/account/auth/sign-in/email", {
    email: "owner@example.com",
    password,
  });
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const body = await json(login);
  expect(body.token).toBeUndefined();
  expect(cookie).toContain("tila-account.session_token");
  return { cookie, token };
}

it("creates an invited password account without email and preserves canonical ownership", async () => {
  const { cookie, token } = await setup();
  const me = await json(await request("/api/account/me", undefined, cookie));
  expect(me.user.role).toBe("admin");
  const projects = await json(
    await request("/api/workspace/projects", undefined, cookie),
  );
  expect(projects.projects).toEqual([
    expect.objectContaining({ projectId: "human-project", role: "owner" }),
  ]);
  await json(
    await request(
      "/api/workspace/select",
      { project_id: "human-project" },
      cookie,
    ),
  );
  const status = await json(
    await request("/auth/session/status", undefined, cookie),
  );
  expect(status.capabilities.memberships_manage).toBe(true);
  expect(status.capabilities.auth_method).toBe("email");
  expect(
    (
      await request("/api/account/invitations/accept", {
        token,
        name: "Replay",
        password,
      })
    ).ok,
  ).toBe(false);
  expect(
    (
      await request(
        `/api/account/admin/users/${me.user.id}`,
        { disabled: true },
        cookie,
        "PATCH",
      )
    ).ok,
  ).toBe(false);
  expect(
    (
      await request("/auth/session", {
        project_id: "human-project",
        token: "tila_any-api-token",
      })
    ).status,
  ).toBe(410);
});

it("approves a CLI and transfers once without refreshing authentication; revocation invalidates descendants", async () => {
  const { cookie } = await setup();
  const device = await json(
    await request("/api/account/auth/device/code", {
      client_id: "tila-cli:Test laptop",
    }),
  );
  await json(
    await request(
      `/api/account/auth/device?user_code=${device.user_code}`,
      undefined,
      cookie,
    ),
  );
  await json(
    await request(
      "/api/account/auth/device/approve",
      { userCode: device.user_code.toLowerCase() },
      cookie,
    ),
  );
  const grant = await json(
    await request("/api/account/auth/device/token", {
      client_id: "tila-cli:Test laptop",
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  );
  expect(grant.access_token).toMatch(/^tila_u_/);
  const bearer = `Bearer ${grant.access_token}`;
  const cli = await json(await request("/api/account/me", undefined, bearer));
  await bindings.DB.prepare(
    "UPDATE _human_sessions SET authenticated_at = ? WHERE id = ?",
  )
    .bind(Date.now() - 3600_000, cli.sessionId)
    .run();
  const link = await json(await request("/api/account/handoff", {}, bearer));
  const token = new URL(link.url).hash.slice(1);
  const consume = await request("/api/account/auth/handoff/consume", { token });
  const browserCookie = consume.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  await json(consume);
  expect(
    (await request("/api/account/auth/handoff/consume", { token })).status,
  ).toBe(401);
  const browser = await json(
    await request("/api/account/me", undefined, browserCookie),
  );
  expect(browser.user.id).toBe(cli.user.id);
  expect(browser.sessionId).not.toBe(cli.sessionId);
  expect(
    (
      await request(
        "/api/account/admin/invitations",
        { email: "other@example.com" },
        browserCookie,
      )
    ).status,
  ).toBe(401);
  await json(
    await request(
      `/api/account/sessions/${cli.sessionId}`,
      undefined,
      cookie,
      "DELETE",
    ),
  );
  expect((await request("/api/account/me", undefined, bearer)).status).toBe(
    401,
  );
  expect(
    (await request("/api/account/me", undefined, browserCookie)).status,
  ).toBe(401);
});

it("rejects token conversion, anonymous signup and cross-origin handoffs", async () => {
  expect(
    (await request("/api/account/handoff", {}, "Bearer tila_reporting-token"))
      .status,
  ).toBe(401);
  expect(
    (
      await request("/api/account/auth/sign-up/email", {
        email: "attacker@example.com",
        password,
        name: "attacker",
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await SELF.fetch(`${origin}/api/account/auth/handoff/consume`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://attacker.example",
        },
        body: JSON.stringify({ token: "a".repeat(64) }),
      })
    ).status,
  ).toBe(403);
});

it("keeps a user's read-only API token scoped and revokes it on demand", async () => {
  const { cookie } = await setup();
  const issued = await json(
    await request(
      "/api/account/tokens",
      {
        projectId: "human-project",
        name: "report",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        policy: { role: "viewer", capabilities: ["tasks:read"] },
      },
      cookie,
    ),
  );
  const bearer = `Bearer ${issued.token}`;
  expect(
    (await request("/projects/human-project/tasks", undefined, bearer)).status,
  ).toBe(200);
  expect(
    (
      await request(
        "/projects/human-project/tasks",
        { id: "forbidden", type: "task", data: { title: "no" } },
        bearer,
      )
    ).status,
  ).toBe(403);
  expect((await request("/api/account/handoff", {}, bearer)).status).toBe(401);
  const list = await json(
    await request(
      "/api/account/tokens?projectId=human-project",
      undefined,
      cookie,
    ),
  );
  expect(list.tokens[0].principal_id).toMatch(/^user:/);
  expect(JSON.stringify(list)).not.toContain(issued.token);
  await json(
    await request(
      "/api/account/tokens/report?projectId=human-project",
      undefined,
      cookie,
      "DELETE",
    ),
  );
  expect(
    (await request("/projects/human-project/tasks", undefined, bearer)).status,
  ).toBe(401);
});

it("consumes account recovery once and signs out old sessions", async () => {
  const { cookie } = await setup();
  const recovery = await json(
    await request(
      "/api/account/admin/recovery",
      { email: "owner@example.com" },
      cookie,
    ),
  );
  const token = new URL(recovery.url).hash.slice(1);
  await json(
    await request("/api/account/recovery/accept", {
      token,
      password: "a-new-password-for-tests",
    }),
  );
  expect((await request("/api/account/me", undefined, cookie)).status).toBe(
    401,
  );
  expect(
    (await request("/api/account/recovery/accept", { token, password })).ok,
  ).toBe(false);
  await json(
    await request("/api/account/auth/sign-in/email", {
      email: "owner@example.com",
      password: "a-new-password-for-tests",
    }),
  );
});

it("rejects a stale browser approving another CLI and resolves account suspension live", async () => {
  const { cookie } = await setup();
  const invite = await json(
    await request(
      "/api/account/admin/invitations",
      { email: "member@example.com", projectId: "human-project" },
      cookie,
    ),
  );
  const token = new URL(invite.url).hash.slice(1);
  const attempts = await Promise.all([
    request("/api/account/invitations/accept", {
      token,
      name: "Member",
      password,
    }),
    request("/api/account/invitations/accept", {
      token,
      name: "Replay",
      password,
    }),
  ]);
  expect(attempts.map((response) => response.status).sort()).toEqual([
    200, 400,
  ]);
  const login = await request("/api/account/auth/sign-in/email", {
    email: "member@example.com",
    password,
  });
  const memberCookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const member = await json(
    await request("/api/account/me", undefined, memberCookie),
  );
  expect(
    (await request("/api/account/admin/users", undefined, memberCookie)).status,
  ).toBe(403);
  const device = await json(
    await request("/api/account/auth/device/code", {
      client_id: "tila-cli:Unapproved",
    }),
  );
  await json(
    await request(
      `/api/account/auth/device?user_code=${device.user_code}`,
      undefined,
      memberCookie,
    ),
  );
  await bindings.DB.prepare(
    "UPDATE _human_sessions SET authenticated_at = ? WHERE id = ?",
  )
    .bind(Date.now() - 3600_000, member.sessionId)
    .run();
  expect(
    (
      await request(
        "/api/account/auth/device/approve",
        { userCode: device.user_code },
        memberCookie,
      )
    ).status,
  ).toBe(401);
  await json(
    await request(
      `/api/account/admin/users/${member.user.id}`,
      { disabled: true },
      cookie,
      "PATCH",
    ),
  );
  expect(
    (await request("/api/account/me", undefined, memberCookie)).status,
  ).toBe(401);
});

it("does not count suspended accounts when protecting the remaining project owner", async () => {
  const { cookie } = await setup();
  const me = await json(await request("/api/account/me", undefined, cookie));
  const invitation = await json(
    await request(
      "/api/account/admin/invitations",
      {
        email: "second-owner@example.com",
        role: "admin",
        projectId: "human-project",
        projectRole: "owner",
      },
      cookie,
    ),
  );
  await json(
    await request("/api/account/invitations/accept", {
      token: new URL(invitation.url).hash.slice(1),
      name: "Second owner",
      password,
    }),
  );
  const second = await bindings.DB.prepare(
    "SELECT id FROM _human_users WHERE email = ?",
  )
    .bind("second-owner@example.com")
    .first<{ id: string }>();
  await json(
    await request(
      `/api/account/admin/users/${second?.id}`,
      { disabled: true },
      cookie,
      "PATCH",
    ),
  );
  const membership = await bindings.DB.prepare(
    "SELECT membership_id FROM _project_memberships WHERE principal_id = ?",
  )
    .bind(`user:${me.user.id}`)
    .first<{ membership_id: string }>();
  const removal = await request(
    `/projects/human-project/memberships/${membership?.membership_id}`,
    undefined,
    cookie,
    "DELETE",
  );
  expect(removal.status).toBe(409);
  expect(await removal.json()).toMatchObject({ error: { code: "last-owner" } });
});

it("recovers an old bootstrap cookie through an explicit account invitation without inheriting token authority", async () => {
  const oldCookie = "tila_session=old-bootstrap-cookie";
  const rawToken = "tila_runtime_legacy_bootstrap";
  const tokenHash = await hashToken(rawToken, bindings.HASH_PEPPER);
  const { cookie } = await setup(async () => {
    const { tokenId } = await new D1TokenStore(bindings.DB).issue({
      tokenHash,
      projectId: "human-project",
      name: "legacy-owner",
      createdAt: Date.now(),
      createdBy: "fixture",
    });
    await new D1SessionStore(bindings.DB).create({
      sessionHash: await hashToken(
        "old-bootstrap-cookie",
        bindings.HASH_PEPPER,
      ),
      tokenHash,
      projectId: "human-project",
      actorName: "legacy-owner",
      principalId: `token:${tokenId}`,
      scopes: "full",
      permission: "admin",
      expiresAt: Date.now() + 3600_000,
    });
    for (const path of [
      "/auth/session/status",
      "/projects/human-project/tasks",
    ]) {
      const response = await request(path, undefined, oldCookie);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: { code: "account-migration-required", retryable: false },
      });
    }
    const identity = await request(
      "/api/whoami",
      undefined,
      `Bearer ${rawToken}`,
    );
    expect(identity.status).toBe(200);
    expect(await identity.json()).toMatchObject({
      role: "owner",
      membership_sources: ["bootstrap"],
    });
    const exchange = await request("/auth/session", {
      token: rawToken,
      project_id: "human-project",
    });
    expect(exchange.status).toBe(410);
    expect(exchange.headers.get("set-cookie")).toBeNull();
    expect(
      await bindings.DB.prepare(
        "SELECT COUNT(*) AS n FROM _project_memberships",
      ).first("n"),
    ).toBe(0);
    // The project bearer cannot replace the infrastructure owner's setup key.
    expect(
      (
        await request(
          "/api/account/setup",
          { email: "wrong@example.com", projectId: "human-project" },
          `Bearer ${rawToken}`,
        )
      ).ok,
    ).toBe(false);
  });
  // Account authentication wins even while the browser still has the old cookie.
  const combined = `${cookie}; ${oldCookie}`;
  await json(
    await request(
      "/api/workspace/select",
      { project_id: "human-project" },
      combined,
    ),
  );
  const status = await json(
    await request("/auth/session/status", undefined, combined),
  );
  expect(status.capabilities.auth_method).toBe("email");
  expect(status.capabilities.memberships_manage).toBe(true);
  expect(
    (await request("/projects/human-project/tasks", undefined, combined))
      .status,
  ).toBe(200);
  const me = await json(await request("/api/account/me", undefined, combined));
  const memberships = await bindings.DB.prepare(
    "SELECT principal_id,role FROM _project_memberships WHERE revoked_at IS NULL",
  ).all();
  expect(memberships.results).toEqual([
    { principal_id: `user:${me.user.id}`, role: "owner" },
  ]);
  // Account creation did not repair or promote the old token identity.
  expect(
    (await request("/auth/session/status", undefined, oldCookie)).status,
  ).toBe(401);
  const logout = await request("/auth/logout", {}, oldCookie);
  expect(logout.status).toBe(200);
  expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(
    await new D1TokenStore(bindings.DB).validate(tokenHash),
  ).not.toBeNull();
});
