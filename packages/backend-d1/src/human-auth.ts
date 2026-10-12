import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { bearer, deviceAuthorization } from "better-auth/plugins";
import type { DeviceAuthorizationGrant } from "better-auth/plugins/device-authorization";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import * as schema from "./human-schema";
import { HumanStore } from "./human-store";

export interface HumanAuthOptions {
  db: D1Database;
  freshAgeMs?: number;
  secret: string;
  baseURL: string;
  uiOrigin: string;
  trustedOrigins: string[];
  github?: { clientId: string; clientSecret: string };
}

// Construct per request: the device grant's authentication event is request-local.
export function createHumanAuth(options: HumanAuthOptions) {
  const db = drizzle(options.db);
  let approvedAt: number | null = null;
  let deviceName: string | null = null;
  return betterAuth({
    appName: "tila",
    secret: options.secret,
    baseURL: options.baseURL,
    basePath: "/api/account/auth",
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    trustedOrigins: options.trustedOrigins,
    advanced: {
      cookiePrefix: "tila-account",
      database: { generateId: () => crypto.randomUUID() },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 60 },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
    },
    account: {
      accountLinking: { enabled: true, disableImplicitLinking: true },
    },
    socialProviders: options.github
      ? { github: { ...options.github, disableSignUp: true } }
      : {},
    user: {
      additionalFields: {
        role: { type: "string", defaultValue: "user", input: false },
        disabled: { type: "boolean", defaultValue: false, input: false },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      // No rolling renewal: a copied login must not outlive its parent device.
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
      additionalFields: {
        authenticatedAt: { type: "number", required: false, input: false },
        device: { type: "boolean", defaultValue: false, input: false },
        deviceName: { type: "string", required: false, input: false },
        parentSessionId: { type: "string", required: false, input: false },
        projectId: { type: "string", defaultValue: "", input: false },
      },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session, ctx) => {
            const [user] = await db
              .select()
              .from(schema.user)
              .where(eq(schema.user.id, session.userId));
            if (!user || user.disabled)
              throw new APIError("UNAUTHORIZED", {
                message: "Account unavailable",
              });
            if (ctx?.path === "/device/token") {
              if (!approvedAt)
                throw new APIError("UNAUTHORIZED", {
                  message: "Device approval required",
                });
              return {
                data: {
                  ...session,
                  authenticatedAt: approvedAt,
                  device: true,
                  deviceName,
                },
              };
            }
            if (
              ctx?.path === "/sign-in/email" ||
              ctx?.path?.startsWith("/callback/")
            ) {
              return { data: { ...session, authenticatedAt: Date.now() } };
            }
            return { data: session };
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/device/approve") return;
        const current = await getSessionFromCtx(ctx);
        if (
          !current ||
          current.user.disabled ||
          current.session.device ||
          !current.session.authenticatedAt ||
          Date.now() - current.session.authenticatedAt >
            (options.freshAgeMs ?? 600_000)
        ) {
          throw new APIError("UNAUTHORIZED", {
            message: "Sign in again before approving this device",
          });
        }
        await db
          .update(schema.deviceCode)
          .set({ authenticatedAt: current.session.authenticatedAt })
          .where(
            and(
              eq(
                schema.deviceCode.userCode,
                String(ctx.body.userCode)
                  .replace(/[^a-zA-Z0-9]/g, "")
                  .toUpperCase(),
              ),
              eq(schema.deviceCode.status, "pending"),
            ),
          );
      }),
    },
    plugins: [
      bearer(),
      {
        id: "tila-handoff",
        endpoints: {
          consumeHandoff: createAuthEndpoint(
            "/handoff/consume",
            {
              method: "POST",
              body: z.object({ token: z.string().length(64) }),
            },
            async (ctx) => {
              const parent = await new HumanStore(options.db).consumeHandoff(
                ctx.body.token,
              );
              if (!parent)
                return new Response(
                  JSON.stringify({ message: "Link expired or already used" }),
                  {
                    status: 401,
                    headers: { "Content-Type": "application/json" },
                  },
                );
              const child = await ctx.context.internalAdapter.createSession(
                parent.user.id,
                false,
                {
                  authenticatedAt: parent.session.authenticatedAt,
                  parentSessionId: parent.session.id,
                  projectId: parent.session.projectId,
                  device: false,
                  expiresAt: new Date(
                    Math.min(
                      parent.session.expiresAt.getTime(),
                      Date.now() + 8 * 3600_000,
                    ),
                  ),
                },
                true,
              );
              if (!child) throw new APIError("INTERNAL_SERVER_ERROR");
              await setSessionCookie(ctx, {
                session: child,
                user: parent.user,
              });
              return ctx.json({ ok: true });
            },
          ),
        },
      },
      deviceAuthorization<DeviceAuthorizationGrant>({
        expiresIn: "10m",
        interval: "5s",
        verificationUri: `${options.uiOrigin}/device`,
        validateClient: (id) => /^tila-cli:[\w .@()-]{1,100}$/.test(id),
        grant: {
          requestSchemaFields: {},
          deviceCodeSchemaFields: {
            authenticatedAt: { type: "number", required: false },
          },
          authorizeRequest: ({ request }) => ({
            clientId: request.client_id ?? "",
            deviceCodeFields: {},
          }),
          assertSessionRedemption: async ({ deviceCode }) => {
            approvedAt =
              typeof deviceCode.authenticatedAt === "number"
                ? deviceCode.authenticatedAt
                : null;
            deviceName = String(deviceCode.clientId).slice(9);
          },
          getVerificationContext: () => undefined,
        },
      }),
    ],
  });
}
export type HumanAuth = ReturnType<typeof createHumanAuth>;
export type HumanSession = NonNullable<
  Awaited<ReturnType<HumanAuth["api"]["getSession"]>>
>;
