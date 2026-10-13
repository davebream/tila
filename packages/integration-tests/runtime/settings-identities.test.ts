import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { bindings } from "./setup";

/**
 * Settings › Agents, Rooms and Signal groups against the real Worker, DO SQLite
 * and D1, from a dashboard cookie session (the headers a browser sends).
 */
const origin = "https://worker";
const project = "identities-project";
const password = "test-password-long-enough";

function call(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    credential?: string;
    key?: string;
  } = {},
) {
  const { body, credential, key } = options;
  return SELF.fetch(`${origin}${path}`, {
    method: options.method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "X-Tila-Participant-Id": "dashboard-runtime-test",
      "X-Tila-Client-Name": "dashboard",
      ...(key ? { "Idempotency-Key": key } : {}),
      ...(credential?.startsWith("Bearer ")
        ? { Authorization: credential }
        : credential
          ? { Cookie: credential }
          : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function ok<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T;
  expect(response.ok, JSON.stringify(body)).toBe(true);
  return body;
}

async function ownerSession() {
  await bindings.DB.prepare(
    `INSERT INTO _projects (project_id,created_at,created_by,cloudflare_account_id) VALUES ('${project}',0,'fixture','local')`,
  ).run();
  const invitation = await ok<{ url: string }>(
    await call("/api/account/setup", {
      body: { email: "owner@example.com", projectId: project },
      credential: "Bearer runtime-test-infra-owner",
    }),
  );
  await ok(
    await call("/api/account/invitations/accept", {
      body: {
        token: new URL(invitation.url).hash.slice(1),
        name: "Owner",
        password,
      },
    }),
  );
  const login = await call("/api/account/auth/sign-in/email", {
    body: { email: "owner@example.com", password },
  });
  await ok(login);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  await ok(
    await call("/api/workspace/select", {
      body: { project_id: project },
      credential: cookie,
    }),
  );
  return cookie;
}

type Agent = { name: string; revision: number; archived: boolean };
type Room = { revision: number; archived: boolean };

it("edits, conflicts, replays and archives agents, rooms and groups from a browser session", async () => {
  const cookie = await ownerSession();
  const root = `/projects/${project}`;

  // Agents: register, rename with a key, replay the same retry, then a stale
  // editor conflicts and learns the current revision.
  const registered = await ok<{ agent: Agent }>(
    await call(`${root}/agents`, {
      body: { id: "worker", name: "Worker" },
      credential: cookie,
    }),
  );
  const rename = {
    method: "PATCH",
    body: {
      expected_revision: registered.agent.revision,
      name: "Builder",
    },
    credential: cookie,
    key: "rename-worker",
  };
  const renamed = await call(`${root}/agents/worker`, rename);
  const renamedText = await renamed.text();
  expect(renamed.status, renamedText).toBe(200);
  const replay = await call(`${root}/agents/worker`, rename);
  expect(await replay.text()).toBe(renamedText);
  const current = (JSON.parse(renamedText) as { agent: Agent }).agent;
  const stale = await call(`${root}/agents/worker`, {
    ...rename,
    body: { expected_revision: registered.agent.revision, name: "Stale" },
    key: "stale-rename",
  });
  expect(stale.status).toBe(412);
  expect(await stale.json()).toMatchObject({
    error: { code: "revision-conflict", revision: current.revision },
  });

  // Archive preview is management-only; archive hides the agent from reads.
  const preview = await ok<{ preview: { binding: unknown; revision: number } }>(
    await call(`${root}/agents/worker/archive-preview`, { credential: cookie }),
  );
  expect(preview.preview).toMatchObject({
    binding: null,
    revision: current.revision,
  });
  const archived = await ok<{ agent: Agent; released: unknown }>(
    await call(`${root}/agents/worker/archive`, {
      body: { expected_revision: current.revision },
      credential: cookie,
      key: "archive-worker",
    }),
  );
  expect(archived).toMatchObject({ agent: { archived: true }, released: null });
  const listed = await ok<{ agents: unknown[] }>(
    await call(`${root}/agents`, { credential: cookie }),
  );
  expect(listed.agents).toEqual([]);
  const withArchived = await ok<{ agents: Array<{ agent: Agent }> }>(
    await call(`${root}/agents?include_archived=true`, { credential: cookie }),
  );
  expect(withArchived.agents[0].agent).toMatchObject({ archived: true });

  // Rooms: settings revision, archive stops publication, history stays.
  const created = await ok<{ room: Room }>(
    await call(`${root}/rooms`, {
      body: { id: "general", name: "General" },
      credential: cookie,
    }),
  );
  const tuned = await ok<{ room: Room }>(
    await call(`${root}/rooms/general`, {
      method: "PATCH",
      body: {
        expected_revision: created.room.revision,
        delivery_ttl_seconds: 3600,
      },
      credential: cookie,
      key: "tune-room",
    }),
  );
  expect(tuned.room.revision).toBeGreaterThan(created.room.revision);
  await ok(
    await call(`${root}/rooms/general/messages`, {
      body: { client_op_id: "before-archive", body: "Keep me" },
      credential: cookie,
    }),
  );
  const closed = await ok<{ room: Room }>(
    await call(`${root}/rooms/general/archive`, {
      body: { expected_revision: tuned.room.revision },
      credential: cookie,
      key: "archive-room",
    }),
  );
  expect(closed.room.archived).toBe(true);
  const refused = await call(`${root}/rooms/general/messages`, {
    body: { client_op_id: "after-archive", body: "Too late" },
    credential: cookie,
  });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({
    error: { code: "room-archived" },
  });
  const history = await ok<{ messages: Array<{ body: string }> }>(
    await call(`${root}/rooms/general/messages`, { credential: cookie }),
  );
  expect(history.messages.map((m) => m.body)).toEqual(["Keep me"]);

  // Signal groups: create-only, delete, then a stale editor conflicts.
  const group = await ok<{ group: { revision: number } }>(
    await call(`${root}/signals/groups/reviewers`, {
      method: "PUT",
      body: { name: "Reviewers", principal_ids: [], expected_revision: 0 },
      credential: cookie,
      key: "create-group",
    }),
  );
  const duplicate = await call(`${root}/signals/groups/reviewers`, {
    method: "PUT",
    body: { name: "Again", principal_ids: [], expected_revision: 0 },
    credential: cookie,
    key: "create-group-again",
  });
  expect(duplicate.status).toBe(412);
  await duplicate.arrayBuffer();
  await ok(
    await call(
      `${root}/signals/groups/reviewers?expected_revision=${group.group.revision}`,
      { method: "DELETE", credential: cookie },
    ),
  );
  await ok(
    await call(`${root}/signals/groups/reviewers`, {
      method: "PUT",
      body: { name: "Reviewers", principal_ids: [], expected_revision: 0 },
      credential: cookie,
      key: "recreate-group",
    }),
  );
  const ghost = await call(`${root}/signals/groups/reviewers`, {
    method: "PUT",
    body: {
      name: "Ghost",
      principal_ids: [],
      expected_revision: group.group.revision,
    },
    credential: cookie,
    key: "ghost-edit",
  });
  expect(ghost.status).toBe(412);
  await ghost.arrayBuffer();

  // A credential without management capabilities sees no management actions.
  const issued = await ok<{ token: string }>(
    await call("/api/account/tokens", {
      body: {
        projectId: project,
        name: "reader",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        policy: {
          role: "participant",
          capabilities: ["agents:read", "conversations:read", "signals:read"],
        },
      },
      credential: cookie,
    }),
  );
  const reader = `Bearer ${issued.token}`;
  for (const [path, method, body] of [
    [`${root}/agents/worker/unarchive`, "POST", { expected_revision: 1 }],
    [`${root}/rooms/general`, "PATCH", { expected_revision: 1, name: "x" }],
    [`${root}/rooms/general/archive-preview`, "GET", undefined],
    [
      `${root}/signals/groups/reviewers`,
      "PUT",
      { name: "x", principal_ids: [] },
    ],
  ] as const) {
    const denied = await call(path, { method, body, credential: reader });
    expect(denied.status, path).toBe(403);
    await denied.arrayBuffer();
  }
});

it("archiving an agent ends its active binding atomically on the real DO", async () => {
  const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
  const principal = "fixture:owner";
  const runtime = {
    run_id: crypto.randomUUID(),
    agent_id: "worker",
    run_role: "acting",
    principal_id: principal,
    participant_id: "fixture",
    enrollment_id: crypto.randomUUID(),
    workload_binding_id: null,
    lease_expires_at: Math.floor(Date.now() / 1000) + 300,
  };
  const send = async (
    path: string,
    body: unknown,
    run: typeof runtime | null = runtime,
  ) => {
    const response = await stub.fetch(`https://project${path}`, {
      method: path.endsWith("archive-preview") ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tila-Agent-Authority": JSON.stringify({
          principal_id: principal,
          can_manage: true,
          runtime: run,
        }),
      },
      ...(path.endsWith("archive-preview")
        ? {}
        : { body: JSON.stringify(body) }),
    });
    return new Response(await response.arrayBuffer(), response);
  };
  const json = async <T>(response: Response) => {
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as T;
  };
  const attach = {
    harness: "cli",
    mechanism: "native-peer",
    capability_report: { protocol: 1, adapter_version: "f", capabilities: {} },
  };
  await json(await send("/agents", { id: "worker", name: "Worker" }));
  await json(
    await send("/agents/worker/bind", { ...attach, expected_epoch: 0 }),
  );
  const { preview } = await json<{
    preview: { revision: number; binding: { binding_epoch: number } };
  }>(await send("/agents/worker/archive-preview", undefined, null));
  const unreviewed = await send(
    "/agents/worker/archive",
    { expected_revision: preview.revision },
    null,
  );
  expect(unreviewed.status).toBe(409);
  const archived = await json<{ released: { binding_epoch: number } }>(
    await send(
      "/agents/worker/archive",
      {
        expected_revision: preview.revision,
        expected_epoch: preview.binding.binding_epoch,
      },
      null,
    ),
  );
  expect(archived.released.binding_epoch).toBe(1);
  // The former holder's renewal is refused.
  const renew = await send("/agents/worker/bind", {
    ...attach,
    expected_epoch: 0,
  });
  expect(renew.status).not.toBe(200);
});
