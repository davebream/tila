import type { ProjectRole } from "@tila/schemas";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { requestIdentityMiddleware } from "../middleware/request-identity";
import type { Env, HonoVariables, UnifiedTokenResult } from "../types";
import { journal } from "./journal";

const report = {
  event_name: "pipeline.tests_passed",
  event_version: 1,
  target: { kind: "project" },
  data: { passed: 87 },
};
const session: UnifiedTokenResult = {
  kind: "session",
  projectId: "p",
  name: "alice",
  scopes: "write",
  tokenId: "",
  permission: "write",
  expiresAt: Date.now() + 600_000,
  jti: "session-jti",
  githubHost: "github.com",
  githubUserId: 42,
  githubLogin: "alice",
  githubRepoId: 9,
};

function setup(roles: { effective: ProjectRole; explicit?: ProjectRole }) {
  const forwarded: Request[] = [];
  const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
  app.use("*", async (c, next) => {
    c.set("tokenResult", session);
    c.set("projectId", "p");
    c.set("effectiveRole", roles.effective);
    c.set("explicitRole", roles.explicit);
    c.set("doStub", {
      fetch: vi.fn(async (request: Request) => {
        forwarded.push(request);
        return Response.json({ ok: true });
      }),
    } as unknown as DurableObjectStub);
    c.set("source", "test");
    await next();
  });
  app.use("*", requestIdentityMiddleware());
  app.route("/projects/p/journal", journal);
  const post = (body: unknown) =>
    app.fetch(
      new Request("http://localhost/projects/p/journal", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "key",
          "X-Tila-Participant-Id": "session",
        },
        body: JSON.stringify(body),
      }),
      // No GitHub App is configured, so a mirrored role cannot be verified.
      {} as Env,
      {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext,
    );
  const roleSent = async () =>
    ((await forwarded[0].json()) as { authorized_role: ProjectRole })
      .authorized_role;
  return { post, forwarded, roleSent };
}

describe("project report correction role", () => {
  it.each([
    ["maintainer", "maintainer"],
    ["owner", "owner"],
    ["participant", "participant"],
  ] as const)(
    "forwards the verified %s role with a correction",
    async (role, expected) => {
      const { post, roleSent } = setup({ effective: role, explicit: role });
      const response = await post({ ...report, corrects_seq: 1 });
      expect(response.status).toBe(200);
      expect(await roleSent()).toBe(expected);
    },
  );

  it("withholds override authority that cannot be verified, without refusing the request", async () => {
    // Explicit participant lifted to maintainer by a mirrored GitHub grant.
    const { post, roleSent, forwarded } = setup({
      effective: "maintainer",
      explicit: "participant",
    });
    const response = await post({ ...report, corrects_seq: 1 });
    expect(response.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(await roleSent()).toBe("participant");
  });

  it("leaves reports that do not correct anything on the resolved role", async () => {
    const { post, roleSent } = setup({
      effective: "maintainer",
      explicit: "participant",
    });
    expect((await post(report)).status).toBe(200);
    expect(await roleSent()).toBe("maintainer");
  });

  it("rejects caller-supplied identity and role fields before forwarding", async () => {
    for (const forged of [
      { actor: "alice" },
      { role: "owner" },
      { authorized_role: "owner" },
      { principal_id: "github:github.com:1" },
      { participant_id: "other" },
    ]) {
      const { post, forwarded } = setup({
        effective: "participant",
        explicit: "participant",
      });
      const response = await post({ ...report, corrects_seq: 1, ...forged });
      expect(response.status).toBe(400);
      expect(forwarded).toHaveLength(0);
    }
  });
});
