import { SELF } from "cloudflare:test";
import { ProjectMembershipStore } from "@tila/backend-d1";
import { SignJWT } from "jose";
import { expect, it } from "vitest";
import { bindings } from "./setup";

it("enforces real D1 memberships, project scope, permission and revocation", async () => {
  await bindings.DB.prepare(
    "INSERT INTO _projects (project_id, display_name, created_at, created_by, cloudflare_account_id) VALUES (?, ?, ?, ?, ?)",
  )
    .bind("runtime-project", "Runtime", Date.now(), "fixture", "local")
    .run();
  const now = Math.floor(Date.now() / 1000);
  const key = Uint8Array.from(
    atob(
      bindings.GITHUB_SESSION_HMAC_KEY.replace(/-/g, "+").replace(/_/g, "/"),
    ),
    (character) => character.charCodeAt(0),
  );
  const token = `tila_s.${await new SignJWT({ authorization_version: 2, project_id: "runtime-project", github_host: "github.com", github_repo_id: 42, github_login: "runtime", github_user_id: 12345, permission: "write", issued_at: now, expires_at: now + 3600, iss: "tila", aud: "tila" }).setProtectedHeader({ alg: "HS256", typ: "JWT" }).sign(key)}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "X-Tila-Participant-Id": "runtime-worker",
    "Content-Type": "application/json",
  };
  const request = (path = "/projects/runtime-project/tasks", method = "GET") =>
    SELF.fetch(`https://worker${path}`, {
      headers,
      method,
      ...(method === "POST"
        ? {
            body: JSON.stringify({
              id: "forbidden",
              type: "task",
              data: { title: "forbidden" },
            }),
          }
        : {}),
    });
  expect((await request()).status).toBe(403);
  const store = new ProjectMembershipStore(bindings.DB);
  const { membership } = await store.grant({
    projectId: "runtime-project",
    principal: { provider: "github", host: "github.com", user_id: 12345 },
    subjectKind: "human",
    role: "viewer",
    actorPrincipalId: "fixture",
  });
  const allowed = await request();
  expect(allowed.status, await allowed.text()).toBe(200);
  expect((await request("/projects/another-project/tasks")).status).toBe(403);
  expect(
    (await request("/projects/runtime-project/tasks", "POST")).status,
  ).toBe(403);
  const revoked = await store.revoke({
    projectId: "runtime-project",
    membershipId: membership.membership_id,
    actorPrincipalId: "fixture",
  });
  expect(revoked?.membership.revoked_at).not.toBeNull();
  // Membership is re-resolved on every request, even for an otherwise valid JWT.
  expect([401, 403]).toContain((await request()).status);
});
