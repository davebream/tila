import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { SignJWT } from "jose";
import { expect, it } from "vitest";
import { D1TokenStore, ProjectMembershipStore } from "../../worker/src/d1";
import { signConversationCursor } from "../../worker/src/do/routes/conversation-cursor";
import worker from "../../worker/src/index";
import { resolveConversationCursorKey } from "../../worker/src/lib/conversation-cursor-key";
import { hashToken } from "../../worker/src/lib/hash";
import { bindings } from "./setup";

type Overrides = Record<string, string | undefined>;
const cursorKey = "runtime-test-dedicated-cursor-key-32+";
type Env = Parameters<typeof worker.fetch>[1];

/** A project on a deployment whose secrets differ from the runtime defaults. */
async function deployment(overrides: Overrides) {
  const env = { ...bindings, ...overrides } as unknown as Env;
  const project = `cursor-key-${crypto.randomUUID()}`;
  await bindings.DB.prepare(
    "INSERT INTO _projects (project_id,created_at,created_by,cloudflare_account_id,membership_mode) VALUES (?,0,'fixture','local','explicit')",
  )
    .bind(project)
    .run();
  const pepper =
    "HASH_PEPPER" in overrides ? overrides.HASH_PEPPER : bindings.HASH_PEPPER;
  const issue = async (name: string) => {
    const token = `tila_${crypto.randomUUID()}${crypto.randomUUID()}`;
    await new D1TokenStore(bindings.DB).issue({
      projectId: project,
      tokenHash: await hashToken(token, pepper),
      name,
      createdBy: "fixture",
      createdAt: 0,
    });
    return token;
  };
  const owner = await issue("owner");
  const http = async (
    path: string,
    init: {
      body?: unknown;
      token?: string;
      env?: Overrides;
      headers?: Record<string, string>;
    } = {},
  ) => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`https://worker/projects/${project}${path}`, {
        method: init.body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${init.token ?? owner}`,
          "Content-Type": "application/json",
          "X-Tila-Participant-Id": "operator",
          ...init.headers,
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
      init.env ? ({ ...env, ...init.env } as unknown as Env) : env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return response;
  };
  return { http, project, issue, env };
}

/** A GitHub session for a viewer: project access without conversations:manage. */
async function viewerSession(project: string) {
  await new ProjectMembershipStore(bindings.DB).grant({
    projectId: project,
    principal: { provider: "github", host: "github.com", user_id: 4242 },
    subjectKind: "human",
    role: "viewer",
    actorPrincipalId: "fixture",
  });
  const now = Math.floor(Date.now() / 1000);
  const key = Uint8Array.from(
    atob(
      bindings.GITHUB_SESSION_HMAC_KEY.replace(/-/g, "+").replace(/_/g, "/"),
    ),
    (character) => character.charCodeAt(0),
  );
  return `tila_s.${await new SignJWT({
    authorization_version: 2,
    project_id: project,
    github_host: "github.com",
    github_repo_id: 42,
    github_login: "viewer",
    github_user_id: 4242,
    permission: "read",
    issued_at: now,
    expires_at: now + 3600,
    iss: "tila",
    aud: "tila",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(key)}`;
}

const unpeppered = {
  HASH_PEPPER: undefined,
  CONVERSATION_CURSOR_KEY: undefined,
};

it("serves conversations without HASH_PEPPER once CONVERSATION_CURSOR_KEY is set", async () => {
  const { http } = await deployment({
    ...unpeppered,
    CONVERSATION_CURSOR_KEY: cursorKey,
  });
  const created = await http("/rooms", {
    body: { id: "general", name: "General" },
  });
  expect(created.status, await created.clone().text()).toBe(200);
  const page = await http("/rooms/general/messages?limit=1");
  expect(page.status, await page.clone().text()).toBe(200);
  const { cursor } = await page.json<{ cursor: string }>();
  // Round trip: a cursor issued under the dedicated key reads back.
  const next = await http(
    `/rooms/general/messages?cursor=${encodeURIComponent(cursor)}`,
  );
  expect(next.status, await next.clone().text()).toBe(200);
});

it("fails closed without a signing secret and shows detail only to managers", async () => {
  const { http, project } = await deployment(unpeppered);
  const manager = await http("/rooms");
  expect(manager.status).toBe(503);
  const body = await manager.json<{
    error: { code: string; message: string; details?: { reason: string } };
  }>();
  expect(body.error.code).toBe("config-unavailable");
  expect(body.error.details?.reason).toBe("missing");
  expect(body.error.message).toContain("CONVERSATION_CURSOR_KEY");
  // A non-managing credential gets the same code without configuration detail.
  const reader = await http("/rooms", {
    token: await viewerSession(project),
  });
  expect(reader.status, await reader.clone().text()).toBe(503);
  const denied = await reader.json<{
    error: { code: string; details?: unknown; message: string };
  }>();
  expect(denied.error.code).toBe("config-unavailable");
  expect(denied.error.details).toBeUndefined();
  expect(denied.error.message).not.toContain("CONVERSATION_CURSOR_KEY");
});

it("rejects a short dedicated key without falling back to HASH_PEPPER", async () => {
  const { http } = await deployment({ CONVERSATION_CURSOR_KEY: "too-short" });
  const response = await http("/rooms");
  expect(response.status).toBe(503);
  expect(
    (await response.json<{ error: { details: { reason: string } } }>()).error
      .details.reason,
  ).toBe("cursor-key-too-short");
});

it("invalidates cursors when the key source changes and ignores a client-supplied key", async () => {
  const { http, project } = await deployment({});
  await http("/rooms", { body: { id: "general", name: "General" } });
  const page = await http("/rooms/general/messages?limit=1");
  expect(page.status, await page.clone().text()).toBe(200);
  const { cursor } = await page.json<{ cursor: string }>();
  const read = (value: string, init: Parameters<typeof http>[1] = {}) =>
    http(`/rooms/general/messages?cursor=${encodeURIComponent(value)}`, init);

  // Same scope and position, re-signed: accepted with the real key, so the
  // forged variant below fails only because of its key.
  const payload = JSON.parse(
    atob(cursor.split(".")[0].replace(/-/g, "+").replace(/_/g, "/")),
  ) as { scope: string; generation: string; position: unknown };
  const real = await resolveConversationCursorKey(bindings, project);
  if (!real.ok) throw new Error("runtime fixture has no cursor key");
  const resign = (secret: string) =>
    signConversationCursor(
      secret,
      payload.scope,
      payload.generation,
      payload.position,
    );
  expect((await read(await resign(real.key))).status).toBe(200);

  const attacker = "attacker-chosen-cursor-signing-key";
  const forged = await read(await resign(attacker), {
    headers: { "X-Tila-Conversation-Cursor-Key": attacker },
  });
  expect(forged.status).toBe(400);
  expect((await forged.json<{ error: { code: string } }>()).error.code).toBe(
    "invalid-cursor",
  );

  // Adding a dedicated key rotates cursors only; the reader restarts.
  const rotated = await read(cursor, {
    env: { CONVERSATION_CURSOR_KEY: cursorKey },
  });
  expect(rotated.status).toBe(400);
  expect((await rotated.json<{ error: { code: string } }>()).error.code).toBe(
    "invalid-cursor",
  );
  const restarted = await http("/rooms/general/messages?limit=1", {
    env: { CONVERSATION_CURSOR_KEY: cursorKey },
  });
  expect(restarted.status).toBe(200);
});
