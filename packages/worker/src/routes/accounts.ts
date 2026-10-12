import {
  HumanInvitationAcceptSchema,
  HumanInvitationRequestSchema,
  HumanRecoveryAcceptSchema,
  HumanRecoveryRequestSchema,
  HumanTokenIssueSchema,
  HumanUserUpdateSchema,
  TokenRotateRequestSchema,
} from "@tila/schemas";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  CredentialConflict,
  CredentialDenied,
  CredentialStore,
  D1RateLimitStore,
  HumanAccountError,
  HumanStore,
  ProjectMembershipStore,
} from "../d1";
import { generateToken, hashToken } from "../lib/hash";
import {
  HUMAN_BEARER_PREFIX,
  accountAuth,
  accountOriginAllowed,
  currentHuman,
  humanHeaders,
} from "../lib/human-auth";
import { stepUpMaxAgeMs } from "../middleware/protected-operation";
import type { Env, HonoVariables } from "../types";
import { requireInfraPrincipal } from "./infra";

type AppEnv = { Bindings: Env; Variables: HonoVariables };
export const accounts = new Hono<AppEnv>();
function authenticated(c: Context<AppEnv>) {
  const current = c.get("humanSession");
  if (!current) throw new Error("Account authentication required");
  return current;
}
const fail = (message: string) => ({
  ok: false,
  error: { code: "account-error", message, retryable: false },
});
accounts.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  if (
    c.req.method !== "GET" &&
    ![
      "/api/account/auth/device/code",
      "/api/account/auth/device/token",
      "/api/account/setup",
      "/api/account/recovery/owner",
      "/api/account/handoff",
    ].includes(c.req.path) &&
    !c.req
      .header("Authorization")
      ?.startsWith(`Bearer ${HUMAN_BEARER_PREFIX}`) &&
    !accountOriginAllowed(c)
  ) {
    return c.json(fail("Request origin denied"), 403);
  }
  await next();
});
accounts.get("/config", (c) =>
  c.json({
    emailPassword: !!(c.env.AUTH_SECRET || c.env.INFRA_ADMIN_TOKEN),
    github:
      c.env.GITHUB_LOGIN_ENABLED === "true" &&
      !!c.env.GITHUB_APP_CLIENT_ID &&
      !!c.env.GITHUB_APP_CLIENT_SECRET,
    emailDelivery: !!c.env.RESEND_API_KEY && !!c.env.EMAIL_FROM,
  }),
);
accounts.all("/auth/*", async (c) => {
  const path = c.req.path.slice("/api/account/auth".length);
  const publicPaths = [
    "/sign-in/email",
    "/sign-in/social",
    "/callback/github",
    "/device/code",
    "/device/token",
    "/handoff/consume",
  ];
  const protectedPaths = [
    "/sign-out",
    "/device",
    "/device/approve",
    "/device/deny",
    "/link-social",
    "/list-accounts",
    "/unlink-account",
    "/change-password",
  ];
  if (![...publicPaths, ...protectedPaths].includes(path))
    return c.json(fail("Not found"), 404);
  if (protectedPaths.includes(path)) {
    const current = await currentHuman(c);
    if (!current) return c.json(fail("Sign in again"), 401);
    if (path === "/device/approve" && current.session.device)
      return c.json(fail("Approve the device in your browser"), 403);
    if (
      [
        "/link-social",
        "/unlink-account",
        "/change-password",
        "/device/approve",
      ].includes(path) &&
      (!current.session.authenticatedAt ||
        Date.now() - current.session.authenticatedAt > stepUpMaxAgeMs(c.env))
    ) {
      return c.json(
        fail("Sign in again before changing account security"),
        401,
      );
    }
  }
  const auth = await accountAuth(c);
  const response = await auth.handler(
    new Request(c.req.raw, { headers: humanHeaders(c.req.raw.headers) }),
  );
  // Browser endpoints never expose reusable login credentials in JSON.
  if (
    response.headers.get("content-type")?.includes("application/json") &&
    path !== "/device/token"
  ) {
    const body = await response.json();
    const sanitized = JSON.stringify(body, (key, value) =>
      key === "token" ? undefined : value,
    );
    return new Response(sanitized, {
      status: response.status,
      headers: response.headers,
    });
  }
  if (path === "/device/token" && response.ok) {
    const body = (await response.json()) as { access_token: string };
    return c.json({
      ...body,
      access_token: `${HUMAN_BEARER_PREFIX}${body.access_token}`,
    });
  }
  return response;
});
accounts.post("/setup", requireInfraPrincipal, async (c) => {
  const store = new HumanStore(c.env.DB);
  if ((await store.users()).length)
    return c.json(fail("An administrator already exists"), 409);
  const input = HumanInvitationRequestSchema.parse(await c.req.json());
  const token = await store.invitation({
    ...input,
    role: "admin",
    projectRole: "owner",
    createdBy: "infra-owner",
  });
  return c.json({
    ok: true,
    url: `${c.env.UI_ORIGIN ?? new URL(c.req.url).origin}/invite#${token}`,
  });
});
accounts.post("/recovery/owner", requireInfraPrincipal, async (c) => {
  const input = HumanRecoveryRequestSchema.parse(await c.req.json());
  const token = await new HumanStore(c.env.DB).recovery(input.email);
  return c.json({
    url: `${c.env.UI_ORIGIN ?? new URL(c.req.url).origin}/recover#${token}`,
  });
});
accounts.post("/recovery/accept", async (c) => {
  const limits = new D1RateLimitStore(c.env.DB);
  const key = `recovery:${c.req.header("CF-Connecting-IP") ?? "local"}`;
  if (await limits.check(key, 10, 60_000))
    return c.json(fail("Too many attempts"), 429);
  await limits.recordFailure(key, 60_000);
  const input = HumanRecoveryAcceptSchema.parse(await c.req.json());
  await new HumanStore(c.env.DB).resetPassword(input.token, input.password);
  return c.json({ ok: true });
});
accounts.post("/handoff/inspect", async (c) => {
  const body = await c.req.json<{ token: string }>();
  if (!/^[a-f0-9]{64}$/.test(body.token))
    return c.json(fail("Invalid link"), 400);
  const current = await new HumanStore(c.env.DB).inspectHandoff(body.token);
  return current
    ? c.json({ email: current.user.email })
    : c.json(fail("Link expired or already used"), 401);
});
accounts.post("/invitations/inspect", async (c) => {
  const body = await c.req.json<{ token: string }>();
  if (!/^[a-f0-9]{64}$/.test(body.token))
    return c.json(fail("Invalid invitation"), 400);
  const invite = await new HumanStore(c.env.DB).inspectInvitation(body.token);
  return invite
    ? c.json({ email: invite.email })
    : c.json(fail("Invitation expired or already used"), 404);
});
accounts.post("/invitations/accept", async (c) => {
  const limits = new D1RateLimitStore(c.env.DB);
  const key = `invite:${c.req.header("CF-Connecting-IP") ?? "local"}`;
  if (await limits.check(key, 10, 60_000))
    return c.json(fail("Too many attempts"), 429);
  await limits.recordFailure(key, 60_000);
  const input = HumanInvitationAcceptSchema.parse(await c.req.json());
  const email = await new HumanStore(c.env.DB).acceptInvitation(
    input.token,
    input.name,
    input.password,
  );
  return c.json({ ok: true, email });
});
accounts.use("*", async (c, next) => {
  const current = await currentHuman(c);
  if (!current) return c.json(fail("Sign in required"), 401);
  c.set("humanSession", current);
  await next();
});
accounts.get("/me", async (c) => {
  const current = authenticated(c);
  return c.json({
    user: {
      id: current.user.id,
      name: current.user.name,
      email: current.user.email,
      role: current.user.role,
    },
    sessionId: current.session.id,
    sessions: await new HumanStore(c.env.DB).listSessions(current.user.id),
  });
});
accounts.delete("/sessions/:id", async (c) => {
  const current = authenticated(c);
  await new HumanStore(c.env.DB).revokeSession(
    current.user.id,
    c.req.param("id"),
  );
  return c.json({ ok: true });
});
accounts.post("/handoff", async (c) => {
  const current = authenticated(c);
  if (
    !c.req
      .header("Authorization")
      ?.startsWith(`Bearer ${HUMAN_BEARER_PREFIX}`) ||
    !current.session.device
  )
    return c.json(fail("Run tila login first"), 403);
  const token = await new HumanStore(c.env.DB).handoff(current.session.id);
  return c.json({
    url: `${c.env.UI_ORIGIN ?? new URL(c.req.url).origin}/handoff#${token}`,
  });
});
accounts.get("/tokens", async (c) => {
  const projectId = c.req.query("projectId");
  if (!projectId) return c.json(fail("Project required"), 400);
  const principalId = `user:${authenticated(c).user.id}`;
  const tokens = (await new CredentialStore(c.env.DB).list(projectId)).filter(
    (token) => token.principal_id === principalId,
  );
  return c.json({ tokens });
});
accounts.use("/tokens*", async (c, next) => {
  const current = authenticated(c);
  if (
    !current.session.authenticatedAt ||
    Date.now() - current.session.authenticatedAt > stepUpMaxAgeMs(c.env)
  )
    return c.json(
      fail("Sign in again before issuing or changing API tokens"),
      401,
    );
  await next();
});
accounts.post("/tokens", async (c) => {
  const input = HumanTokenIssueSchema.parse(await c.req.json());
  if (input.expiresAt > Math.floor(Date.now() / 1000) + 366 * 86400)
    return c.json(fail("Token expiry must be within one year"), 400);
  const principalId = `user:${authenticated(c).user.id}`;
  const plaintext = await generateToken();
  const issued = await new CredentialStore(c.env.DB).issue(
    {
      projectId: input.projectId,
      principalId,
      name: input.name,
      policy: input.policy,
      expiresAt: input.expiresAt,
      tokenHash: await hashToken(plaintext, c.env.HASH_PEPPER),
    },
    { principalId },
  );
  return c.json({ ...issued, token: plaintext });
});
accounts.on(["DELETE", "POST"], "/tokens/:name", async (c) => {
  const projectId = c.req.query("projectId");
  if (!projectId) return c.json(fail("Project required"), 400);
  const principalId = `user:${authenticated(c).user.id}`;
  const store = new CredentialStore(c.env.DB);
  const credential = await store.find(projectId, c.req.param("name"));
  if (!credential || credential.principal_id !== principalId)
    return c.json(fail("Token not found"), 404);
  if (c.req.method === "DELETE") {
    await store.revoke(projectId, credential.name, { principalId });
    return c.json({ ok: true });
  }
  const input = TokenRotateRequestSchema.parse(await c.req.json());
  const plaintext = await generateToken();
  const result = await store.rotate(
    projectId,
    credential.name,
    input.expected_token_id,
    await hashToken(plaintext, c.env.HASH_PEPPER),
    input.overlap_seconds,
    { principalId },
  );
  return c.json({ ...result, token: plaintext });
});
accounts.use("/admin/*", async (c, next) => {
  const current = authenticated(c);
  if (current.user.role !== "admin")
    return c.json(fail("Administrator access required"), 403);
  if (
    c.req.method !== "GET" &&
    (!current.session.authenticatedAt ||
      Date.now() - current.session.authenticatedAt > stepUpMaxAgeMs(c.env))
  )
    return c.json(fail("Sign in again before changing users"), 401);
  await next();
});
accounts.post("/admin/recovery", async (c) => {
  const input = HumanRecoveryRequestSchema.parse(await c.req.json());
  const token = await new HumanStore(c.env.DB).recovery(input.email);
  return c.json({
    url: `${c.env.UI_ORIGIN ?? new URL(c.req.url).origin}/recover#${token}`,
  });
});
accounts.get("/admin/users", async (c) =>
  c.json({ users: await new HumanStore(c.env.DB).users() }),
);
accounts.patch("/admin/users/:id", async (c) => {
  const input = HumanUserUpdateSchema.parse(await c.req.json());
  await new HumanStore(c.env.DB).updateUser(c.req.param("id"), input);
  return c.json({ ok: true });
});
accounts.get("/admin/invitations", async (c) =>
  c.json({ invitations: await new HumanStore(c.env.DB).listInvitations() }),
);
accounts.delete("/admin/invitations/:id", async (c) => {
  await new HumanStore(c.env.DB).revokeInvitation(c.req.param("id"));
  return c.json({ ok: true });
});
accounts.post("/admin/invitations", async (c) => {
  const input = HumanInvitationRequestSchema.parse(await c.req.json());
  const current = authenticated(c);
  const token = await new HumanStore(c.env.DB).invitation({
    ...input,
    createdBy: `user:${current.user.id}`,
  });
  const url = `${c.env.UI_ORIGIN ?? new URL(c.req.url).origin}/invite#${token}`;
  let emailSent = false;
  if (input.sendEmail && c.env.RESEND_API_KEY && c.env.EMAIL_FROM) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: c.env.EMAIL_FROM,
        to: [input.email],
        subject: "Your tila invitation",
        text: `You have been invited to tila. Create your account using this link within 7 days:\n${url}`,
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    emailSent = response?.ok ?? false;
  }
  return c.json({ ok: true, url, emailSent });
});
accounts.onError((error, c) => {
  if (error.name === "ZodError")
    return c.json(fail("Invalid account request"), 400);
  if (
    error instanceof HumanAccountError ||
    error instanceof CredentialDenied ||
    error instanceof CredentialConflict
  )
    return c.json(fail(error.message), 400);
  // Do not return provider/database errors containing credentials or hashes.
  console.error("[account] request failed", error.name);
  return c.json(fail("Account service unavailable; try again shortly"), 503);
});
