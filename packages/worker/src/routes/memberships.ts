import { ProjectMembershipStore } from "@tila/backend-d1";
import {
  MembershipGrantRequestSchema,
  MembershipPolicyRequestSchema,
  MembershipRoleUpdateRequestSchema,
} from "@tila/schemas";
import { Hono } from "hono";
import { requireProjectOwner } from "../middleware/require-project-owner";
import type { Env, HonoVariables } from "../types";

type AppEnv = { Bindings: Env; Variables: HonoVariables };

export const memberships = new Hono<AppEnv>();
memberships.use("/membership-policy", requireProjectOwner);
memberships.use("/memberships", requireProjectOwner);
memberships.use("/memberships/*", requireProjectOwner);
memberships.use("/membership-events", requireProjectOwner);

function actor(c: import("hono").Context<AppEnv>): string {
  return c.get("principalId") ?? "bootstrap:unknown";
}

memberships.get("/membership-policy", async (c) => {
  const mode = await new ProjectMembershipStore(c.env.DB).getMode(
    c.get("projectId"),
  );
  if (!mode) {
    return c.json(
      { ok: false, error: { code: "not-found", message: "Project not found" } },
      404,
    );
  }
  return c.json({ ok: true, mode });
});

memberships.put("/membership-policy", async (c) => {
  const parsed = MembershipPolicyRequestSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json(
      {
        ok: false,
        error: {
          code: "validation-error",
          message: "Invalid membership policy",
          retryable: false,
        },
      },
      400,
    );
  }
  const updated = await new ProjectMembershipStore(c.env.DB).setMode(
    c.get("projectId"),
    parsed.data.mode,
    actor(c),
  );
  return updated
    ? c.json({ ok: true, mode: parsed.data.mode })
    : c.json(
        {
          ok: false,
          error: { code: "not-found", message: "Project not found" },
        },
        404,
      );
});

memberships.get("/memberships", async (c) => {
  const includeRevoked = c.req.query("include_revoked") === "true";
  const rows = await new ProjectMembershipStore(c.env.DB).list(
    c.get("projectId"),
    includeRevoked,
  );
  return c.json({ ok: true, memberships: rows });
});

memberships.post("/memberships", async (c) => {
  const parsed = MembershipGrantRequestSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json(
      {
        ok: false,
        error: {
          code: "validation-error",
          message:
            parsed.error.issues[0]?.message ?? "Invalid membership grant",
          retryable: false,
        },
      },
      400,
    );
  }
  const result = await new ProjectMembershipStore(c.env.DB).grant({
    projectId: c.get("projectId"),
    principal: parsed.data.principal,
    subjectKind: parsed.data.subject_kind,
    role: parsed.data.role,
    displayName: parsed.data.display_name,
    actorPrincipalId: actor(c),
  });
  return c.json(
    { ok: true, membership: result.membership, created: result.created },
    result.created ? 201 : 200,
  );
});

memberships.patch("/memberships/:membershipId", async (c) => {
  const parsed = MembershipRoleUpdateRequestSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json(
      {
        ok: false,
        error: { code: "validation-error", message: "Invalid role" },
      },
      400,
    );
  }
  const store = new ProjectMembershipStore(c.env.DB);
  const current = await store.getById(
    c.get("projectId"),
    c.req.param("membershipId"),
  );
  const bootstrap = c.get("tokenResult").kind === "d1-token";
  if (
    current?.role === "owner" &&
    parsed.data.role !== "owner" &&
    !bootstrap &&
    (await store.countActiveOwners(c.get("projectId"))) <= 1
  ) {
    return c.json(
      {
        ok: false,
        error: {
          code: "last-owner",
          message: "Cannot demote the last project owner",
          retryable: false,
        },
      },
      409,
    );
  }
  const membership = await store.updateRole({
    projectId: c.get("projectId"),
    membershipId: c.req.param("membershipId"),
    role: parsed.data.role,
    actorPrincipalId: actor(c),
  });
  return membership
    ? c.json({ ok: true, membership })
    : c.json(
        {
          ok: false,
          error: { code: "not-found", message: "Membership not found" },
        },
        404,
      );
});

memberships.delete("/memberships/:membershipId", async (c) => {
  const store = new ProjectMembershipStore(c.env.DB);
  const current = await store.getById(
    c.get("projectId"),
    c.req.param("membershipId"),
  );
  const bootstrap = c.get("tokenResult").kind === "d1-token";
  if (
    current?.role === "owner" &&
    !bootstrap &&
    (await store.countActiveOwners(c.get("projectId"))) <= 1
  ) {
    return c.json(
      {
        ok: false,
        error: {
          code: "last-owner",
          message: "Cannot revoke the last project owner",
          retryable: false,
        },
      },
      409,
    );
  }
  const result = await store.revoke({
    projectId: c.get("projectId"),
    membershipId: c.req.param("membershipId"),
    actorPrincipalId: actor(c),
  });
  return result
    ? c.json({ ok: true, ...result })
    : c.json(
        {
          ok: false,
          error: { code: "not-found", message: "Membership not found" },
        },
        404,
      );
});

memberships.get("/membership-events", async (c) => {
  const cursorRaw = c.req.query("cursor");
  const limitRaw = Number(c.req.query("limit") ?? "50");
  const cursor = cursorRaw === undefined ? null : Number(cursorRaw);
  if (
    (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 0)) ||
    !Number.isSafeInteger(limitRaw) ||
    limitRaw < 1 ||
    limitRaw > 100
  ) {
    return c.json(
      {
        ok: false,
        error: { code: "validation-error", message: "Invalid pagination" },
      },
      400,
    );
  }
  const events = await new ProjectMembershipStore(c.env.DB).listEvents(
    c.get("projectId"),
    cursor,
    limitRaw,
  );
  return c.json({
    ok: true,
    events: events.map((event) => ({
      ...event,
      details: JSON.parse(event.details_json),
      details_json: undefined,
    })),
    next_cursor:
      events.length === limitRaw ? (events.at(-1)?.occurred_at ?? null) : null,
  });
});
