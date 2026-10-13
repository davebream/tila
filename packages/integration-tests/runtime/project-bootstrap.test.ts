import { SELF } from "cloudflare:test";
import { MembershipGrantResponseSchema } from "@tila/schemas";
import { expect, it } from "vitest";
import { hashToken } from "../../worker/src/lib/hash";
import { bindings } from "./setup";

it("repairs bootstrap credentials and seeds canonical owners through the real Worker membership API", async () => {
  const projectId = "bootstrap-project";
  const token = `tila_${crypto.randomUUID()}${crypto.randomUUID()}`;
  const tokenHash = await hashToken(token, bindings.HASH_PEPPER);
  await bindings.DB.prepare(
    "INSERT INTO _projects (project_id, created_at, created_by, cloudflare_account_id) VALUES (?, 0, 'tila-init', 'local')",
  )
    .bind(projectId)
    .run();
  // Reproduce an old CLI write after all historical one-time backfills ran.
  await bindings.DB.prepare(
    "INSERT INTO _tokens (token_hash, project_id, name, scopes, created_at, created_by) VALUES (?, ?, 'init', 'full', 0, 'tila-init')",
  )
    .bind(tokenHash, projectId)
    .run();
  await bindings.DB.prepare(
    "INSERT INTO _admin_grants (project_id, github_user_id, granted_at) VALUES (?, 7, 1791820000)",
  )
    .bind(projectId)
    .run();
  const repair = bindings.TEST_MIGRATIONS.find((migration) =>
    migration.name.includes("0033_project_bootstrap_repair"),
  );
  expect(repair).toBeDefined();
  if (!repair)
    throw new Error("Bootstrap repair migration missing from runtime payload");
  await bindings.DB.batch(
    repair.queries.map((sql) => bindings.DB.prepare(sql)),
  );
  const credential = await bindings.DB.prepare(
    "SELECT token_id FROM _tokens WHERE token_hash = ?",
  )
    .bind(tokenHash)
    .first<{ token_id: string }>();
  expect(credential?.token_id).toMatch(/^[0-9a-f]{32}$/);
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Tila-Participant-Id": "bootstrap-operator",
  };
  const whoami = await SELF.fetch("https://worker/api/whoami", { headers });
  expect(whoami.status).toBe(200);
  expect(await whoami.json()).toMatchObject({
    token_id: credential?.token_id,
    role: "owner",
    principal_id: `token:${credential?.token_id}`,
  });

  const request = (userId: number) =>
    SELF.fetch(`https://worker/projects/${projectId}/memberships`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        principal: {
          provider: "github",
          host: "github.com",
          user_id: userId,
          login: "octocat",
        },
        subject_kind: "human",
        role: "owner",
      }),
    });
  const seeded = await request(8);
  expect(seeded.status).toBe(201);
  const result = MembershipGrantResponseSchema.parse(await seeded.json());
  expect(result).toMatchObject({
    created: true,
    membership: {
      project_id: projectId,
      principal_id: "github:github.com:8",
      role: "owner",
      display_name: "octocat",
      granted_by: `token:${credential?.token_id}`,
    },
  });
  const repeated = await request(8);
  expect(repeated.status).toBe(200);
  expect(
    MembershipGrantResponseSchema.parse(await repeated.json()),
  ).toMatchObject({
    created: false,
    membership: {
      membership_id: result.membership.membership_id,
      role: "owner",
    },
  });
  const roster = await SELF.fetch(
    `https://worker/projects/${projectId}/admins`,
    { headers },
  );
  expect(roster.status).toBe(200);
  expect(await roster.json()).toMatchObject({
    admins: expect.arrayContaining([
      expect.objectContaining({ github_user_id: 7 }),
      expect.objectContaining({ github_user_id: 8 }),
    ]),
  });
  const audit = await bindings.DB.prepare(
    "SELECT principal_id, actor_principal_id, action FROM _membership_events WHERE project_id = ? ORDER BY principal_id",
  )
    .bind(projectId)
    .all();
  expect(audit.results).toEqual([
    {
      principal_id: "github:github.com:7",
      actor_principal_id: "bootstrap:repair-360",
      action: "grant",
    },
    {
      principal_id: "github:github.com:8",
      actor_principal_id: `token:${credential?.token_id}`,
      action: "grant",
    },
  ]);
  const legacy = await bindings.DB.prepare(
    "SELECT COUNT(*) AS count FROM _admin_grants WHERE project_id = ?",
  )
    .bind(projectId)
    .first();
  expect(legacy).toEqual({ count: 1 });
});
