import { CREDENTIAL_PRESETS } from "@tila/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectMembershipStore } from "../src/project-memberships";
import { RuntimeStore } from "../src/runtime-store";
import { createCredentialFixture } from "./helpers/credential-fixture";

describe("runtime authority", () => {
  let f: ReturnType<typeof createCredentialFixture>;
  let store: RuntimeStore;
  let now: number;
  const secret = () => ({ id: crypto.randomUUID(), hash: crypto.randomUUID() });
  const input = () => ({
    operation_id: crypto.randomUUID(),
    installation_id: crypto.randomUUID(),
    name: "Installation",
    jkt: "a".repeat(43),
  });
  beforeEach(async () => {
    f = createCredentialFixture();
    now = 1000;
    store = new RuntimeStore(f.db, () => now);
    for (const id of ["1", "2"])
      await new ProjectMembershipStore(f.db).grant({
        projectId: "p",
        principal: {
          provider: "github",
          host: "github.com",
          user_id: Number(id),
        },
        subjectKind: "human",
        role: "participant",
        actorPrincipalId: "bootstrap",
      });
  });
  afterEach(() => f.sqlite.close());
  async function enroll(sponsor = "github:github.com:1") {
    return store.enroll(
      "p",
      input(),
      sponsor,
      CREDENTIAL_PRESETS.worker,
      secret(),
    );
  }
  async function start(enrollment: string) {
    return store.start(
      enrollment,
      { operation_id: crypto.randomUUID(), jkt: "b".repeat(43) },
      secret(),
    );
  }
  it("isolates two installations per human and all concurrent run participants", async () => {
    const installations = await Promise.all([
      enroll(),
      enroll(),
      enroll("github:github.com:2"),
      enroll("github:github.com:2"),
    ]);
    const runs = await Promise.all(
      installations.flatMap((parent) => [
        start(required(parent.enrollment_id)),
        start(required(parent.enrollment_id)),
      ]),
    );
    expect(new Set(runs.map((run) => run.participant_id)).size).toBe(8);
    expect(
      f.sqlite.prepare("SELECT COUNT(*) n FROM _service_accounts").get(),
    ).toEqual({ n: 4 });
    await store.revokeEnrollment(
      required(installations[0].enrollment_id),
      "owner",
    );
    await expect(store.context(runs[0].token_id)).rejects.toMatchObject({
      code: "enrollment-revoked",
    });
    for (const run of runs.slice(2))
      expect((await store.context(run.token_id)).run_id).toBe(run.run_id);
  });
  it("revalidates sponsor membership and narrows live policy", async () => {
    const parent = await enroll();
    const run = await start(required(parent.enrollment_id));
    f.sqlite
      .prepare(
        "UPDATE _project_memberships SET role = 'viewer' WHERE principal_id = ?",
      )
      .run("github:github.com:1");
    expect(
      (await store.context(run.token_id)).policy.capabilities,
    ).not.toContain("tasks:write");
    f.sqlite
      .prepare(
        "UPDATE _project_memberships SET revoked_at = 1 WHERE principal_id = ?",
      )
      .run("github:github.com:1");
    await expect(store.context(run.token_id)).rejects.toMatchObject({
      code: "enrollment-revoked",
    });
  });
  it("redeems once, recovers only the same installation, and keeps shared authority independent", async () => {
    await store.invite(
      "p",
      "github:github.com:1",
      "Shared",
      CREDENTIAL_PRESETS.worker,
      "invitation",
    );
    const setup = input();
    const parent = await store.enroll(
      "p",
      setup,
      null,
      CREDENTIAL_PRESETS.worker,
      secret(),
      "invitation",
    );
    await expect(
      store.enroll(
        "p",
        input(),
        null,
        CREDENTIAL_PRESETS.worker,
        secret(),
        "invitation",
      ),
    ).rejects.toThrow();
    const recovered = await store.enroll(
      "p",
      setup,
      null,
      CREDENTIAL_PRESETS.worker,
      secret(),
      "invitation",
    );
    expect(recovered.principal_id).toBe(parent.principal_id);
    await expect(store.context(parent.token_id)).rejects.toThrow();
    f.sqlite
      .prepare(
        "UPDATE _project_memberships SET revoked_at = 1 WHERE provider = 'github'",
      )
      .run();
    expect((await start(required(parent.enrollment_id))).purpose).toBe("run");
    expect(
      f.sqlite.prepare("SELECT COUNT(*) n FROM _service_accounts").get(),
    ).toEqual({ n: 1 });
  });
  it("permits only one successor and limits overlap to sixty seconds", async () => {
    const parent = await enroll();
    const run = await start(required(parent.enrollment_id));
    const results = await Promise.allSettled([
      store.renew(required(run.run_id), run.token_id, secret()),
      store.renew(required(run.run_id), run.token_id, secret()),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({
      reason: { code: "runtime-renewal-conflict", status: 409 },
    });
    await expect(store.context(run.token_id)).resolves.toBeDefined();
    now += 60;
    await expect(store.context(run.token_id)).rejects.toThrow();
    const successor = results.find((result) => result.status === "fulfilled");
    if (successor?.status !== "fulfilled") throw new Error("Missing successor");
    await store.finish(required(run.run_id), parent.principal_id, "closed");
    await expect(store.context(successor.value.token_id)).rejects.toMatchObject(
      { code: "run-closed" },
    );
    await expect(
      store.renew(required(run.run_id), successor.value.token_id, secret()),
    ).rejects.toThrow();
  });
  it("never revives an expired lease through heartbeat or ambiguous-create recovery", async () => {
    const parent = await enroll();
    const request = { operation_id: crypto.randomUUID(), jkt: "b".repeat(43) };
    const run = await store.start(
      required(parent.enrollment_id),
      request,
      secret(),
    );
    now += 300;
    await expect(store.heartbeat(required(run.run_id))).rejects.toMatchObject({
      code: "run-expired",
    });
    await expect(
      store.start(required(parent.enrollment_id), request, secret()),
    ).rejects.toMatchObject({ code: "run-expired" });
    await expect(store.context(run.token_id)).rejects.toMatchObject({
      code: "run-expired",
    });
  });
  it("rejects escalation and revokes all runtime authority before project restore", async () => {
    const parent = await enroll();
    const run = await start(required(parent.enrollment_id));
    await expect(
      store.start(
        required(parent.enrollment_id),
        {
          operation_id: crypto.randomUUID(),
          jkt: "b".repeat(43),
          policy: { role: "owner", capabilities: ["tokens:issue"] },
        },
        secret(),
      ),
    ).rejects.toMatchObject({ code: "runtime-policy-denied" });
    await store.invite(
      "p",
      "owner",
      "unused invitation",
      CREDENTIAL_PRESETS.worker,
      "unused",
    );
    await store.revokeProject("p", "owner");
    await expect(
      store.enroll(
        "p",
        input(),
        null,
        CREDENTIAL_PRESETS.worker,
        secret(),
        "unused",
      ),
    ).rejects.toThrow();
    await expect(store.context(parent.token_id)).rejects.toThrow();
    await expect(store.context(run.token_id)).rejects.toThrow();
  });
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing expected fixture value");
  return value;
}
