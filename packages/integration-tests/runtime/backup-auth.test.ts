import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { D1TokenStore } from "../../worker/src/d1";
import { hashToken } from "../../worker/src/lib/hash-token";
import { bindings } from "./setup";

const INFRA_TOKEN = "runtime-test-infra-owner";
const CLIENT_IP = "203.0.113.77";

async function seedProject(project: string): Promise<string> {
  await bindings.DB.prepare(
    "INSERT INTO _projects (project_id, display_name, created_at, created_by, cloudflare_account_id) VALUES (?, 'Backup auth', 0, 'fixture', 'local')",
  )
    .bind(project)
    .run();
  const token = `tila_${crypto.randomUUID()}${crypto.randomUUID()}`;
  await new D1TokenStore(bindings.DB).issue({
    projectId: project,
    tokenHash: await hashToken(token, bindings.HASH_PEPPER),
    name: "owner",
    createdBy: "fixture",
    createdAt: 0,
  });
  return token;
}

function call(
  path: string,
  options: {
    method?: string;
    credential?: string;
    participant?: string;
    slug?: string;
    body?: unknown;
  } = {},
) {
  const method = options.method ?? "GET";
  return SELF.fetch(`https://worker${path}`, {
    method,
    headers: {
      ...(options.credential
        ? { Authorization: `Bearer ${options.credential}` }
        : {}),
      "CF-Connecting-IP": CLIENT_IP,
      "Content-Type": "application/json",
      ...(options.slug ? { "X-Confirm-Slug": options.slug } : {}),
      ...(options.participant !== undefined
        ? { "X-Tila-Participant-Id": options.participant }
        : {}),
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
}

async function rateLimitRows(): Promise<number> {
  const result = await bindings.DB.prepare(
    "SELECT COUNT(*) AS rows FROM _rate_limits WHERE ip = ?",
  )
    .bind(CLIENT_IP)
    .first<{ rows: number }>();
  return result?.rows ?? 0;
}

describe("project-token backup export", () => {
  it("begins and completes an export for an identified participant", async () => {
    const project = "backup-auth-project";
    const token = await seedProject(project);
    const root = `/projects/${project}/admin/backup`;
    const begin = await call(`${root}/transfer/begin`, {
      method: "POST",
      credential: token,
      participant: "backup-operator",
      slug: project,
      body: { sessionId: "export-1", mode: "export", ttlMs: 60_000 },
    });
    expect(begin.status, await begin.clone().text()).toBe(200);

    const status = await call(`${root}/transfer/status`, {
      credential: token,
      participant: "backup-operator",
    });
    expect(status.status).toBe(200);
    const { state } = (await status.json()) as {
      state: { session_id: string; mode: string; owner: string };
    };
    expect(state).toMatchObject({ session_id: "export-1", mode: "export" });
    expect(state.owner).toMatch(/^token:/);

    const done = await call(`${root}/transfer/complete-export`, {
      method: "POST",
      credential: token,
      participant: "backup-operator",
      slug: project,
      body: { sessionId: "export-1" },
    });
    expect(done.status, await done.clone().text()).toBe(200);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["oversized", "p".repeat(256)],
  ] as const)(
    "rejects a %s participant without freezing the project",
    async (_label, participant) => {
      const project = "backup-auth-negative";
      const token = await seedProject(project);
      const root = `/projects/${project}/admin/backup`;
      const begin = await call(`${root}/transfer/begin`, {
        method: "POST",
        credential: token,
        participant,
        slug: project,
        body: { sessionId: "export-1", mode: "export", ttlMs: 60_000 },
      });
      expect(begin.status).toBe(400);
      expect(await begin.json()).toMatchObject({
        error: { code: "participant-required" },
      });

      const status = await call(`${root}/transfer/status`, {
        credential: token,
        participant: "backup-operator",
      });
      expect(await status.json()).toEqual({ state: null });
    },
  );

  it("does not accept the infrastructure secret as a project token", async () => {
    const project = "backup-auth-secret-as-project";
    await seedProject(project);
    const response = await call(
      `/projects/${project}/admin/backup/transfer/status`,
      { credential: INFRA_TOKEN, participant: "backup-operator" },
    );
    expect(response.status).toBe(401);
  });

  it("does not accept another project's token", async () => {
    const other = await seedProject("backup-auth-other");
    await seedProject("backup-auth-target");
    const response = await call(
      "/projects/backup-auth-target/admin/backup/transfer/status",
      { credential: other, participant: "backup-operator" },
    );
    expect(response.ok).toBe(false);
    expect([401, 403]).toContain(response.status);
  });
});

describe("infrastructure-token backup route", () => {
  it("authorizes a full export transfer with the infrastructure secret only", async () => {
    const project = "backup-auth-infra";
    await seedProject(project);
    const root = `/_internal/admin/projects/${project}/backup`;
    const begin = await call(`${root}/transfer/begin`, {
      method: "POST",
      credential: INFRA_TOKEN,
      slug: project,
      body: { sessionId: "infra-export", mode: "export", ttlMs: 60_000 },
    });
    expect(begin.status, await begin.clone().text()).toBe(200);

    const status = await call(`${root}/transfer/status`, {
      credential: INFRA_TOKEN,
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      state: { session_id: "infra-export", mode: "export", owner: "infra" },
    });

    const d1 = await call(`${root}/d1?sessionId=infra-export`, {
      credential: INFRA_TOKEN,
    });
    expect(d1.status, await d1.clone().text()).toBe(200);

    const done = await call(`${root}/transfer/complete-export`, {
      method: "POST",
      credential: INFRA_TOKEN,
      slug: project,
      body: { sessionId: "infra-export" },
    });
    expect(done.status, await done.clone().text()).toBe(200);
  });

  it("does not record a failed project-token attempt for the infrastructure secret", async () => {
    const project = "backup-auth-infra-limit";
    await seedProject(project);
    for (let i = 0; i < 3; i++) {
      const response = await call(
        `/_internal/admin/projects/${project}/backup/transfer/status`,
        { credential: INFRA_TOKEN },
      );
      expect(response.status).toBe(200);
    }
    expect(await rateLimitRows()).toBe(0);
  });

  it("answers 403 for a missing or wrong bearer", async () => {
    const project = "backup-auth-infra-wrong";
    const projectToken = await seedProject(project);
    const path = `/_internal/admin/projects/${project}/backup/transfer/status`;
    for (const credential of [undefined, "not-the-secret", projectToken]) {
      const response = await call(path, { credential });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: "forbidden" },
      });
    }
  });

  it("is not reachable for an unregistered project", async () => {
    const response = await call(
      "/_internal/admin/projects/never-registered/backup/transfer/status",
      { credential: INFRA_TOKEN },
    );
    expect(response.status).toBe(404);
  });

  it("keeps other internal routes off project-token auth", async () => {
    const project = "backup-auth-internal-other";
    await seedProject(project);
    const counts = await call(
      `/_internal/admin/projects/${project}/store-counts`,
      { credential: INFRA_TOKEN },
    );
    expect(counts.status, await counts.clone().text()).toBe(200);

    const sweep = await call("/_internal/sweep", { method: "POST" });
    expect(sweep.status).toBe(403);
    expect(await sweep.json()).toMatchObject({
      error: { message: "Invalid sweep secret" },
    });
  });
});
