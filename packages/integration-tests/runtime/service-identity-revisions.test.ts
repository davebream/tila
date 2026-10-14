import { SELF } from "cloudflare:test";
import { CREDENTIAL_PRESETS } from "@tila/schemas";
import { expect, it } from "vitest";
import { D1TokenStore } from "../../worker/src/d1";
import { hashToken } from "../../worker/src/lib/hash-token";
import { bindings } from "./setup";

it("conditionally edits service identities in real D1 and preserves authority boundaries", async () => {
  const project = "service-revisions";
  await bindings.DB.prepare(
    "INSERT INTO _projects (project_id, created_at, created_by, cloudflare_account_id) VALUES (?, 0, 'fixture', 'local')",
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
  const root = `/projects/${project}/service-accounts`;
  const call = (path: string, method = "GET", body?: unknown) =>
    SELF.fetch(`https://worker${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Tila-Participant-Id": "service-revision-test",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function ok<T>(response: Response): Promise<T> {
    const body = (await response.json()) as T;
    expect(response.ok, JSON.stringify(body)).toBe(true);
    return body;
  }
  const { service_account: account } = await ok<{
    service_account: { principal_id: string; revision: number };
  }>(
    await call(root, "POST", {
      name: "ci",
      display_name: "CI",
      role: "participant",
    }),
  );
  expect(account.revision).toBe(1);
  const path = `${root}/${encodeURIComponent(account.principal_id)}`;
  const { binding } = await ok<{
    binding: { binding_id: string; revision: number };
  }>(
    await call(`${path}/workload-bindings`, "POST", {
      name: "ci",
      provider: "oidc",
      issuer: "https://issuer.example",
      subject: "ci",
      policy: CREDENTIAL_PRESETS["read-only"],
    }),
  );
  expect(binding.revision).toBe(1);
  const bindingPath = `${path}/workload-bindings/${binding.binding_id}`;
  for (const edit of [
    {
      path,
      resource: "service-account",
      event: "service-updated",
      body: { display_name: "Winner" },
    },
    {
      path: bindingPath,
      resource: "workload-binding",
      event: "workload-policy-updated",
      body: { policy: CREDENTIAL_PRESETS.worker },
    },
  ]) {
    const results = await Promise.all(
      [1, 2].map(() =>
        call(edit.path, "PATCH", { ...edit.body, expected_revision: 1 }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 412]);
    for (const response of results) {
      const body = await response.json();
      if (response.status === 412)
        expect(body).toMatchObject({
          error: {
            code: "revision-conflict",
            revision: 2,
            resource: edit.resource,
          },
        });
    }
    expect(
      await bindings.DB.prepare(
        "SELECT count(*) AS n FROM _credential_events WHERE project_id = ? AND action = ?",
      )
        .bind(project, edit.event)
        .first(),
    ).toEqual({ n: 1 });
    await ok(await call(edit.path, "PATCH", edit.body)); // Legacy omission remains supported.
  }
  expect(await ok(await call(root))).toMatchObject({
    service_accounts: [{ revision: 3 }],
  });
  expect(await ok(await call(`${path}/workload-bindings`))).toMatchObject({
    bindings: [{ revision: 3 }],
  });
  await bindings.DB.prepare(
    "UPDATE _project_memberships SET role = 'viewer' WHERE project_id = ? AND principal_id = ?",
  )
    .bind(project, account.principal_id)
    .run();
  const capped = await ok<{
    binding: {
      policy: { role: string; capabilities: string[] };
      revision: number;
    };
  }>(
    await call(bindingPath, "PATCH", {
      policy: CREDENTIAL_PRESETS.worker,
      expected_revision: 3,
    }),
  );
  expect(capped.binding.revision).toBe(4);
  expect(capped.binding.policy.role).toBe("viewer");
  expect(capped.binding.policy.capabilities).not.toContain("tasks:write");
  const rootPolicy = await call(bindingPath, "PATCH", {
    policy: { role: "owner", capabilities: ["project:destroy"] },
    expected_revision: 4,
  });
  expect(rootPolicy.status).toBe(403);
  await rootPolicy.arrayBuffer();
  const missing = await call(`${path}/workload-bindings/foreign`, "PATCH", {
    policy: CREDENTIAL_PRESETS.worker,
    expected_revision: 1,
  });
  expect(missing.status).toBe(404);
  expect(await missing.json()).not.toHaveProperty("error.revision");
  // Revocation races cannot revive a policy: either update precedes revocation,
  // or the update is a missing-target outcome, never an authority resurrection.
  const revokeRace = await Promise.all([
    call(bindingPath, "DELETE"),
    call(bindingPath, "PATCH", {
      policy: CREDENTIAL_PRESETS.worker,
      expected_revision: 4,
    }),
  ]);
  expect(revokeRace[0].status).toBe(200);
  expect([200, 404]).toContain(revokeRace[1].status);
  for (const response of revokeRace) await response.arrayBuffer();
  const revoked = await call(bindingPath, "PATCH", {
    policy: CREDENTIAL_PRESETS.worker,
    expected_revision: 1,
  });
  expect(revoked.status).toBe(404);
  expect(await revoked.json()).not.toHaveProperty("error.revision");
  await ok(await call(path, "DELETE"));
  const revokedAccount = await call(path, "PATCH", {
    display_name: "Revive",
    expected_revision: 1,
  });
  expect(revokedAccount.status).toBe(404);
  expect(await revokedAccount.json()).not.toHaveProperty("error.revision");
});
