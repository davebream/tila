import {
  CAPABILITIES,
  type Capability,
  type CredentialPolicy,
  PROJECT_ROLE_RANK,
  type ProjectRole,
  capabilityRole,
  effectiveCredentialPolicy,
  hasNamespaceRestrictions,
  permitsRecord,
  permitsTask,
} from "@tila/schemas";
import type { Context, MiddlewareHandler } from "hono";
import { forwardToDO } from "../lib/do-forward";
import type { Env, HonoVariables } from "../types";
import { resolveTokenMembership } from "./membership";
import { authorizeProtectedOperation } from "./protected-operation";
import { principalIdFor } from "./request-identity";

type AppEnv = { Bindings: Env; Variables: HonoVariables };
export function denied(c: Context<AppEnv>) {
  try {
    c.env.ANALYTICS?.writeDataPoint({
      blobs: ["authorization", "denied", c.req.method],
      doubles: [1],
    });
  } catch {
    /* Best effort. */
  }
  return c.json(
    {
      ok: false,
      error: {
        code: "permission-denied",
        message: "Credential does not permit this operation or resource",
        retryable: false,
      },
    },
    403,
  );
}
export function scopedPolicy(c: Context<AppEnv>): CredentialPolicy | undefined {
  const token = c.get("tokenResult");
  return token.kind === "d1-token" || token.kind === "cookie-session"
    ? token.policy
    : undefined;
}

/** Explicit route inventory: unknown routes never inherit a family-wide grant. */
export function routeCapability(
  method: string,
  rawPath: string,
): Capability | null {
  const path =
    rawPath
      .replace(/^\/projects\/[^/]+/, "")
      .replace(/^\/(entities|work-units)(?=\/|$)/, "/tasks")
      .replace(/\/$/, "") || "/";
  const read = method === "GET" || method === "HEAD";
  const patterns: Array<[string, RegExp, Capability]> = [
    [
      "GET",
      /^\/tasks(?:\/ready|\/relationships|\/[^/]+(?:\/artifact-refs)?)?$/,
      "tasks:read",
    ],
    [
      "POST",
      /^\/tasks(?:\/relationships|\/[^/]+\/artifact-refs)?$/,
      "tasks:write",
    ],
    ["PATCH", /^\/tasks\/[^/]+$/, "tasks:write"],
    ["POST", /^\/tasks\/[^/]+\/archive$/, "tasks:delete"],
    ["DELETE", /^\/tasks\/relationships$/, "tasks:delete"],
    ["GET", /^\/records(?:\/.*)?$/, "records:read"],
    [
      "POST",
      /^\/records\/[^/]+\/~\/(?:archive|unarchive)\/.+$/,
      "records:delete",
    ],
    ["POST", /^\/records\/[^/]+(?:\/~\/put\/.+)?$/, "records:write"],
    ["PUT", /^\/records\/[^/]+\/.+$/, "records:write"],
    ["PATCH", /^\/records\/[^/]+\/.+$/, "records:write"],
    ["GET", /^\/artifacts(?:\/.*)?$/, "artifacts:read"],
    ["POST", /^\/artifacts(?:\/text|\/relationship)?$/, "artifacts:write"],
    ["DELETE", /^\/artifacts\/.+$/, "artifacts:delete"],
    ["POST", /^\/artifacts\/(?:reconcile|search-rebuild)$/, "search:reindex"],
    ["GET", /^\/claims(?:\/state\/.+)?$/, "claims:read"],
    ["POST", /^\/claims\/acquire$/, "claims:acquire"],
    ["POST", /^\/claims\/renew$/, "claims:renew"],
    ["POST", /^\/claims\/release$/, "claims:release"],
    ["GET", /^\/signals(?:\/groups(?:\/[^/]+)?)?$/, "signals:read"],
    ["GET", /^\/signals\/history$/, "signals:manage"],
    ["POST", /^\/signals\/send$/, "signals:send"],
    ["POST", /^\/signals\/[^/]+\/ack$/, "signals:ack"],
    ["PUT", /^\/signals\/groups\/[^/]+$/, "signals:manage"],
    ["DELETE", /^\/signals\/groups\/[^/]+$/, "signals:manage"],
    ["GET", /^\/presence(?:\/all)?$/, "presence:read"],
    ["POST", /^\/presence\/heartbeat$/, "presence:heartbeat"],
    ["GET", /^\/gates$/, "gates:read"],
    ["POST", /^\/gates$/, "gates:create"],
    ["POST", /^\/gates\/[^/]+\/resolve$/, "gates:resolve"],
    ["DELETE", /^\/gates\/[^/]+$/, "gates:delete"],
    ["GET", /^\/(?:schema|templates)$/, "schema:read"],
    ["POST", /^\/schema\/preview$/, "schema:preview"],
    ["POST", /^\/schema$/, "schema:write"],
    ["POST", /^\/templates\/instantiate$/, "templates:instantiate"],
    ["GET", /^\/search$/, "search:read"],
    ["POST", /^\/search\/reindex$/, "search:reindex"],
    ["GET", /^\/search\/reindex\/status$/, "search:reindex"],
    ["GET", /^\/journal(?:\/(?:replay|cursor))?$/, "journal:read"],
    ["PUT", /^\/journal\/cursor$/, "journal:read"],
    ["GET", /^\/handoffs(?:\/[^/]+)?$/, "journal:read"],
    ["POST", /^\/handoffs$/, "tasks:write"],
    ["GET", /^\/reentry$/, "summary:read"],
    ["GET", /^\/summary$/, "summary:read"],
    ["GET", /^\/doctor\/(?:search-drift|schema|probe)$/, "project:inspect"],
    ["POST", /^\/admin\/restart$/, "project:restart"],
    ["POST", /^\/admin\/archive\/journal$/, "journal:archive"],
    ["GET", /^\/admin\/store-counts$/, "project:inspect"],
    ["POST", /^\/admin\/destroy$/, "project:destroy"],
    ["POST", /^\/admin\/sessions\/revoke$/, "project:sessions-revoke"],
    [
      "POST",
      /^\/admin\/principals\/(?:[^/]+\/)?revoke$/,
      "project:principals-revoke",
    ],
  ];
  for (const [verb, regex, cap] of patterns)
    if ((read ? "GET" : method) === verb && regex.test(path)) return cap;
  if (
    /^\/(?:memberships(?:\/[^/]+)?|membership-policy|membership-events|admins(?:\/[^/]+)?)$/.test(
      path,
    )
  )
    return read
      ? "memberships:read"
      : ["POST", "PUT", "PATCH", "DELETE"].includes(method)
        ? "memberships:manage"
        : null;
  if (/^\/service-accounts(?:\/[^/]+)?$/.test(path))
    return read
      ? "service-accounts:read"
      : ["POST", "PATCH", "DELETE"].includes(method)
        ? "service-accounts:manage"
        : null;
  if (/^\/service-accounts\/[^/]+\/workload-bindings(?:\/[^/]+)?$/.test(path))
    return read
      ? "workload-bindings:read"
      : ["POST", "PATCH", "DELETE"].includes(method)
        ? "workload-bindings:manage"
        : null;
  if (/^\/admin\/backup(?:\/.*)?$/.test(path))
    return read ? "project:export" : "project:import";
  return null;
}

export async function credentialManagementGuard(
  c: Context<AppEnv>,
  capability: Capability,
) {
  const deny = () =>
    c.json(
      {
        ok: false,
        error: {
          code: "token-authz-denied",
          message: "Owner membership and token capability required",
          retryable: false,
        },
      },
      403,
    );
  const token = c.get("tokenResult");
  if (!token || token.kind === "workspace-session") return deny();
  const policy = scopedPolicy(c);
  if (policy) {
    const membership = await resolveTokenMembership(
      c.env.DB,
      token,
      token.projectId,
    );
    if (
      !membership ||
      membership.role !== "owner" ||
      !policy.capabilities.includes(capability)
    )
      return deny();
    c.set("credentialPolicy", policy);
    return null;
  }
  if (token.kind === "d1-token") return token.scopes === "full" ? null : deny();
  try {
    principalIdFor(token);
  } catch {
    return deny();
  }
  const membership = await resolveTokenMembership(
    c.env.DB,
    token,
    token.projectId,
  );
  if (membership?.role !== "owner") return deny();
  c.set("effectiveRole", membership.role);
  c.set("explicitRole", membership.explicitRole);
  return authorizeProtectedOperation(c, "owner");
}

export const auxiliaryCapabilityMiddleware: MiddlewareHandler<AppEnv> = async (
  c,
  next,
) => {
  if (!scopedPolicy(c)) return next();
  if (c.req.path.startsWith("/api/repos")) {
    const error = await credentialManagementGuard(
      c,
      c.req.method === "GET"
        ? "repository-policy:read"
        : "repository-policy:manage",
    );
    if (error) return error;
  }
  if (c.req.path.startsWith("/api/workspace")) return denied(c);
  return next();
};

export function capabilityMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = c.get("tokenResult");
    const scoped = scopedPolicy(c);
    if (token.kind === "d1-token" && token.scopes !== "full" && !scoped)
      return denied(c);
    const role = c.get("effectiveRole");
    if (!scoped && !role) return denied(c);
    const policy = scoped ?? compatibilityPolicy(role ?? "viewer");

    let capability = routeCapability(c.req.method, c.req.path);
    if (
      c.req.method === "POST" &&
      /\/admin\/backup\/transfer\/(begin|renew|complete-export)$/.test(
        c.req.path,
      )
    ) {
      if (c.req.path.endsWith("/complete-export"))
        capability = "project:export";
      else if (c.req.path.endsWith("/begin")) {
        const body = (await c.req.raw
          .clone()
          .json()
          .catch(() => ({}))) as { mode?: string };
        capability =
          body?.mode === "export" ? "project:export" : "project:import";
      } else {
        const status = await forwardToDO(
          c.get("doStub"),
          "/admin/transfer/status",
          "GET",
        );
        if (!status.ok) return status;
        const body = (await status.json()) as { state?: { mode: string } };
        capability =
          body.state?.mode === "export" ? "project:export" : "project:import";
      }
    }
    if (!capability || !policy.capabilities.includes(capability))
      return denied(c);
    // Continuity aggregates embed references, claims, and (for re-entry) signals.
    // Authorize every component before reading a snapshot or replaying a response.
    const continuityPath = c.req.path
      .replace(/^\/projects\/[^/]+/, "")
      .replace(/\/$/, "");
    if (
      c.req.method === "PUT" &&
      continuityPath === "/journal/cursor" &&
      PROJECT_ROLE_RANK[policy.role] < PROJECT_ROLE_RANK.participant
    )
      return denied(c);
    if (/^\/(?:handoffs(?:\/[^/]+)?|reentry)$/.test(continuityPath)) {
      const required: Capability[] = [
        "journal:read",
        "tasks:read",
        "records:read",
        "artifacts:read",
        "claims:read",
      ];
      if (continuityPath === "/reentry")
        required.push("summary:read", "signals:read");
      if (required.some((cap) => !policy.capabilities.includes(cap)))
        return denied(c);
    }
    if (!scoped) return next(); // Compatibility handlers retain GitHub rechecks and historical gates.
    c.set("credentialPolicy", policy);
    if (
      /artifact-refs/.test(c.req.path) &&
      !policy.capabilities.includes("artifacts:read")
    )
      return denied(c);
    if (c.req.method === "POST" && c.req.path.endsWith("/claims/acquire")) {
      const body = (await c.req.raw
        .clone()
        .json()
        .catch(() => ({}))) as { mode?: string };
      if (
        body?.mode === "presence" &&
        !policy.capabilities.includes("presence:heartbeat")
      )
        return denied(c);
    }
    if (hasNamespaceRestrictions(policy)) {
      const path = c.req.path
        .replace(/^\/projects\/[^/]+/, "")
        .replace(/^\/(entities|work-units)(?=\/|$)/, "/tasks");
      // Authorize record namespaces before Worker-side snapshot writes to R2.
      if (path.startsWith("/records/")) {
        const parts = path.slice(9).split("/").map(decodeURIComponent);
        const type = parts.shift() ?? "";
        const body =
          c.req.method === "GET" || c.req.method === "HEAD"
            ? {}
            : ((await c.req.raw
                .clone()
                .json()
                .catch(() => ({}))) as Record<string, unknown>);
        let key: unknown = parts.length ? parts.join("/") : body?.key;
        if (parts[0] === "~") key = parts.slice(2).join("/");
        if (
          typeof key === "string" &&
          !permitsRecord(policy.restrictions, type, key)
        )
          return denied(c);
        if (body?.source_artifact_key) return denied(c);
      }
      // The listed surfaces cannot safely project their cross-resource data.
      if (!/^\/(tasks|records|claims|templates)(\/|$)/.test(path))
        return denied(c);
      if (/^\/tasks\/ready(?:\/|$)/.test(path) || /artifact-refs/.test(path))
        return denied(c);
    }
    // Send only server-derived policy to the DO. Client headers never reach it.
    const original = c.get("doStub");
    c.set(
      "doStub",
      new Proxy(original, {
        get(target, property) {
          if (property !== "fetch")
            return Reflect.get(target, property, target);
          return (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(input, init);
            request.headers.set(
              "X-Tila-Credential-Policy",
              JSON.stringify(policy),
            );
            return target.fetch(request);
          };
        },
      }),
    );
    c.set("authorizationChecked", true);
    c.header("Cache-Control", "no-store");
    await next();
    c.header("Cache-Control", "no-store");
  };
}

export function compatibilityPolicy(role: ProjectRole): CredentialPolicy {
  return effectiveCredentialPolicy(
    { role, capabilities: [...CAPABILITIES] },
    role,
  );
}
