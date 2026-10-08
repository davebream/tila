import { PROJECT_ROLE_RANK, capabilityRole } from "@tila/schemas";
import {
  CAPABILITIES,
  CREDENTIAL_PRESETS,
  CredentialPolicySchema,
  effectiveCredentialPolicy,
  permitsRecord,
  policyContains,
} from "@tila/schemas";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { admin } from "../routes/admin";
import { adminRoster } from "../routes/admin-roster";
import { artifacts } from "../routes/artifacts";
import { backup } from "../routes/backup";
import { claims } from "../routes/claims";
import { continuity } from "../routes/continuity";
import { doctor } from "../routes/doctor";
import { entities } from "../routes/entities";
import { gates } from "../routes/gates";
import { journal } from "../routes/journal";
import { memberships } from "../routes/memberships";
import { presence } from "../routes/presence";
import { records } from "../routes/records";
import { schemaRoutes } from "../routes/schema";
import { search } from "../routes/search";
import { serviceAccountRoutes } from "../routes/service-accounts";
import { signals } from "../routes/signals";
import { summary } from "../routes/summary";
import { templates } from "../routes/templates";
import type { Env, HonoVariables } from "../types";
import { capabilityMiddleware, routeCapability } from "./capability";

describe("route capability inventory", () => {
  for (const [prefix, app] of [
    ["/tasks", entities],
    ["/entities", entities],
    ["/work-units", entities],
    ["/records", records],
    ["/claims", claims],
    ["/artifacts", artifacts],
    ["/signals", signals],
    ["/presence", presence],
    ["/gates", gates],
    ["/journal", journal],
    ["", continuity],
    ["/templates", templates],
    ["/schema", schemaRoutes],
    ["/search", search],
    ["/admin", admin],
    ["", doctor],
    ["", memberships],
    ["/admin/backup", backup],
    ["/admins", adminRoster],
    ["/summary", summary],
    ["/service-accounts", serviceAccountRoutes],
  ] as const) {
    for (const route of app.routes.filter((route) => route.method !== "ALL")) {
      const path = `${prefix}${route.path}`.replace(
        /:([\w]+)(?:\{[^}]+\})?/g,
        "sample",
      );
      it(`${route.method} ${path} has an explicit known capability`, () => {
        expect(CAPABILITIES).toContain(
          routeCapability(route.method, `/projects/project${path}`),
        );
      });
      it(`${route.method} ${path} enforces role and explicit capability before execution`, async () => {
        const required = routeCapability(
          route.method,
          `/projects/project${path}`,
        );
        if (!required) throw new Error("Missing capability");
        for (const role of [
          "viewer",
          "participant",
          "maintainer",
          "owner",
        ] as const) {
          for (const grant of [true, false]) {
            const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
            app.use("*", async (c, next) => {
              c.set("tokenResult", {
                kind: "d1-token",
                projectId: "project",
                name: "matrix",
                tokenId: "id",
                scopes: "scoped-v1",
                policy: effectiveCredentialPolicy(
                  {
                    role: "owner",
                    capabilities: grant ? [...CAPABILITIES] : [],
                  },
                  role,
                ),
              });
              c.set("doStub", {
                fetch: async () =>
                  new Response(JSON.stringify({ state: null })),
              } as unknown as DurableObjectStub);
              await next();
            });
            app.use("*", capabilityMiddleware());
            app.all("*", (c) => c.json({ executed: true }));
            const response = await app.request(
              `/projects/project${path}`,
              {
                method: route.method,
                ...(route.method === "GET"
                  ? {}
                  : {
                      body: "{}",
                      headers: { "Content-Type": "application/json" },
                    }),
              },
              {} as Env,
            );
            expect(response.status).toBe(
              grant &&
                !(
                  route.method === "PUT" &&
                  path === "/journal/cursor" &&
                  role === "viewer"
                ) &&
                PROJECT_ROLE_RANK[role] >=
                  PROJECT_ROLE_RANK[capabilityRole(required)]
                ? 200
                : 403,
            );
          }
        }
      });
    }
  }
  it("does not infer deletion or governance from write", () => {
    expect(
      routeCapability("POST", "/projects/p/records/config/~/archive/team/a"),
    ).toBe("records:delete");
    expect(routeCapability("POST", "/projects/p/tasks/id/archive")).toBe(
      "tasks:delete",
    );
    expect(routeCapability("POST", "/projects/p/admin/destroy")).toBe(
      "project:destroy",
    );
    expect(
      routeCapability("POST", "/projects/p/tasks/new-admin-operation"),
    ).toBeNull();
  });
});

describe("policy intersections", () => {
  it("drops grants above current membership without inferring missing grants", () => {
    const policy = {
      role: "owner" as const,
      capabilities: [
        "records:read",
        "records:write",
        "records:delete",
        "tokens:issue",
      ] as const,
    };
    expect(
      effectiveCredentialPolicy(
        { ...policy, capabilities: [...policy.capabilities] },
        "viewer",
      ).capabilities,
    ).toEqual(["records:read"]);
    expect(CREDENTIAL_PRESETS["artifact-writer"].capabilities).not.toContain(
      "artifacts:delete",
    );
    expect(CREDENTIAL_PRESETS["coordination-only"].capabilities).not.toContain(
      "records:write",
    );
  });
  it("distinguishes absent restrictions from empty and respects segment boundaries", () => {
    expect(permitsRecord(undefined, "config", "anything")).toBe(true);
    expect(permitsRecord({ records: [] }, "config", "anything")).toBe(false);
    const restrictions = {
      records: [{ type: "config", key_prefixes: ["team/a"] }],
    };
    expect(permitsRecord(restrictions, "config", "team/a/child")).toBe(true);
    expect(permitsRecord(restrictions, "config", "team/ab")).toBe(false);
    const parent = { ...CREDENTIAL_PRESETS["read-only"], restrictions };
    expect(policyContains(parent, { ...parent, restrictions: undefined })).toBe(
      false,
    );
    expect(
      policyContains(parent, {
        ...parent,
        restrictions: {
          records: [{ type: "config", key_prefixes: ["team/a/child"] }],
        },
      }),
    ).toBe(true);
  });
  it("rejects unknown capabilities and restriction keys", () => {
    expect(
      CredentialPolicySchema.safeParse({ role: "owner", capabilities: ["*"] })
        .success,
    ).toBe(false);
    expect(
      CredentialPolicySchema.safeParse({
        role: "viewer",
        capabilities: [],
        restrictions: { types: [] },
      }).success,
    ).toBe(false);
  });
});
