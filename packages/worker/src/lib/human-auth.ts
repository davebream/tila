import type { Context } from "hono";
import { HumanStore, createHumanAuth, humanSecretHash } from "../d1";
import { stepUpMaxAgeMs } from "../middleware/protected-operation";
import type { Env, HonoVariables } from "../types";
import { parseAllowedOrigins } from "./parse-allowed-origins";

export const HUMAN_BEARER_PREFIX = "tila_u_";
type AccountContext = Context<{ Bindings: Env; Variables: HonoVariables }>;
export async function accountAuth(c: AccountContext) {
  const source = c.env.AUTH_SECRET ?? c.env.INFRA_ADMIN_TOKEN;
  if (!source)
    throw new Error(
      "Account authentication requires AUTH_SECRET or INFRA_ADMIN_TOKEN",
    );
  const origin = new URL(c.req.url).origin;
  const uiOrigin = c.env.UI_ORIGIN ?? origin;
  return createHumanAuth({
    db: c.env.DB,
    freshAgeMs: stepUpMaxAgeMs(c.env),
    secret:
      c.env.AUTH_SECRET ??
      (await humanSecretHash(`tila:human-auth:v1:${source}`)),
    baseURL: origin,
    uiOrigin,
    trustedOrigins: [
      origin,
      uiOrigin,
      ...parseAllowedOrigins(c.env.CORS_ALLOWED_ORIGINS ?? ""),
    ],
    github:
      c.env.GITHUB_LOGIN_ENABLED === "true" &&
      c.env.GITHUB_APP_CLIENT_ID &&
      c.env.GITHUB_APP_CLIENT_SECRET
        ? {
            clientId: c.env.GITHUB_APP_CLIENT_ID,
            clientSecret: c.env.GITHUB_APP_CLIENT_SECRET,
          }
        : undefined,
  });
}
export function humanHeaders(headers: Headers) {
  const result = new Headers(headers);
  const bearer = result.get("authorization");
  if (bearer?.startsWith(`Bearer ${HUMAN_BEARER_PREFIX}`)) {
    result.set(
      "authorization",
      `Bearer ${bearer.slice(7 + HUMAN_BEARER_PREFIX.length)}`,
    );
    result.delete("cookie");
  } else result.delete("authorization");
  return result;
}
export function hasHumanCredential(headers: Headers) {
  return (
    headers.get("authorization")?.startsWith(`Bearer ${HUMAN_BEARER_PREFIX}`) ||
    /(?:^|;\s*)(?:__Secure-)?tila-account\.session_token=/.test(
      headers.get("cookie") ?? "",
    )
  );
}
export async function currentHuman(c: AccountContext) {
  if (!hasHumanCredential(c.req.raw.headers)) return null;
  const auth = await accountAuth(c);
  const session = await auth.api.getSession({
    headers: humanHeaders(c.req.raw.headers),
  });
  if (!session) return null;
  const live = await new HumanStore(c.env.DB).live(session.session.id);
  if (!live) return null;
  if (
    c.req
      .header("Authorization")
      ?.startsWith(`Bearer ${HUMAN_BEARER_PREFIX}`) &&
    !live.session.device
  )
    return null;
  return live;
}
export function accountOriginAllowed(c: AccountContext) {
  const origin = c.req.header("Origin");
  return (
    !!origin &&
    [
      new URL(c.req.url).origin,
      c.env.UI_ORIGIN,
      ...parseAllowedOrigins(c.env.CORS_ALLOWED_ORIGINS ?? ""),
    ].includes(origin)
  );
}
