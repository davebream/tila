import { SELF } from "cloudflare:test";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { D1TokenStore } from "@tila/backend-d1";
import { ConversationInboxResponseSchema } from "@tila/schemas";
import {
  RUNTIME_RUN_CEILING,
  type RuntimeCredentialResponse,
  accessTokenHash,
  canonicalizeHtu,
} from "@tila/schemas";
import {
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
} from "jose";
import { createAgentMethods } from "tila-sdk";
import { TilaClient } from "tila-sdk";
import { createConversationMethods, createInboxMethods } from "tila-sdk";
import { expect, it } from "vitest";
import { z } from "zod";
import { registerConversationTools } from "../../mcp-server/src/tools/conversations";
import { hashToken } from "../../worker/src/lib/hash";
import { bindings } from "./setup";

it("exchanges durable peer messages between authenticated SDK runs and rejects replay after revocation", async () => {
  const project = `conversations-${crypto.randomUUID()}`;
  const root = `/projects/${project}`;
  await bindings.DB.prepare(
    "INSERT INTO _projects (project_id,created_at,created_by,cloudflare_account_id,membership_mode) VALUES (?,0,'fixture','local','explicit')",
  )
    .bind(project)
    .run();
  const owner = `tila_${crypto.randomUUID()}${crypto.randomUUID()}`;
  await new D1TokenStore(bindings.DB).issue({
    projectId: project,
    tokenHash: await hashToken(owner, bindings.HASH_PEPPER),
    name: "owner",
    createdBy: "fixture",
    createdAt: 0,
  });
  async function key() {
    const pair = await generateKeyPair("ES256");
    const jwk = await exportJWK(pair.publicKey);
    return { pair, jwk, jkt: await calculateJwkThumbprint(jwk) };
  }
  async function proof(
    k: Awaited<ReturnType<typeof key>>,
    token: string,
    method: string,
    url: string,
  ) {
    return new SignJWT({
      htm: method,
      htu: canonicalizeHtu(url),
      ath: await accessTokenHash(token),
      iat: Math.floor(Date.now() / 1000),
      jti: crypto.randomUUID(),
    })
      .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: k.jwk })
      .sign(k.pair.privateKey);
  }
  async function http(
    path: string,
    body?: unknown,
    token = owner,
    k?: Awaited<ReturnType<typeof key>>,
    participant = "operator",
    headers: Record<string, string> = {},
  ) {
    const method = body === undefined ? "GET" : "POST";
    const url = `https://worker${root}${path}`;
    return SELF.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Tila-Participant-Id": participant,
        ...(k ? { DPoP: await proof(k, token, method, url) } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function json<T>(r: Response): Promise<T> {
    expect(r.status, await r.clone().text()).toBe(200);
    return r.json<T>();
  }
  const installation = await key();
  const invite = await json<{ invitation: string }>(
    await http("/runtime/invitations", {
      name: "host",
      policy: RUNTIME_RUN_CEILING,
    }),
  );
  const parent = await json<RuntimeCredentialResponse>(
    await http(
      "/runtime/redeem",
      {
        invitation: invite.invitation,
        name: "host",
        installation_id: crypto.randomUUID(),
        operation_id: crypto.randomUUID(),
        jkt: installation.jkt,
        policy: RUNTIME_RUN_CEILING,
      },
      invite.invitation,
      installation,
    ),
  );
  const start = async (agent: string, role: "acting" | "relay" = "acting") => {
    const k = await key();
    const run = await json<RuntimeCredentialResponse>(
      await http(
        "/runtime/runs",
        {
          agent_id: agent,
          run_role: role,
          operation_id: crypto.randomUUID(),
          jkt: k.jkt,
          policy:
            role === "relay"
              ? {
                  role: "participant",
                  capabilities: ["agent-bindings:attach", "dispatch:relay"],
                }
              : RUNTIME_RUN_CEILING,
        },
        parent.token,
        installation,
      ),
    );
    const client = new TilaClient({
      baseUrl: "https://worker",
      token: run.token,
      participantId: run.context.participant_id ?? "missing-participant",
      dpopSigner: (method, url) => proof(k, run.token, method, url),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await SELF.fetch(input, {
          ...init,
          redirect: "manual",
        });
        if (response.status >= 300 && response.status < 400)
          throw new Error("Unexpected redirect");
        return response;
      }) as typeof fetch,
    });
    return {
      run,
      k,
      client,
      rooms: createConversationMethods(client, project),
      inbox: createInboxMethods(client, project),
    };
  };
  for (const id of ["one", "two"])
    await json(
      await http("/agents", {
        id,
        name: id,
        bind_policy: [
          { principal_id: parent.context.principal_id, agent_id: id },
        ],
      }),
    );
  const one = await start("one");
  const two = await start("two");
  const attach = {
    expected_epoch: 0,
    harness: "fixture",
    capability_report: {
      protocol: 1,
      adapter_version: "fixture",
      capabilities: {},
    },
  };
  for (const session of [one, two])
    await json(
      await http(
        `/agents/${session.run.context.agent_id}/bind`,
        attach,
        session.run.token,
        session.k,
        session.run.context.participant_id ?? "missing-participant",
      ),
    );
  await json(await http("/rooms", { id: "general", name: "General" }));
  for (const id of ["one", "two"]) {
    const r = await SELF.fetch(
      `https://worker${root}/rooms/general/members/agent:${id}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${owner}`,
          "Content-Type": "application/json",
          "X-Tila-Participant-Id": "operator",
        },
        body: JSON.stringify({ wake: true }),
      },
    );
    await json(r);
  }
  const input = {
    client_op_id: "request-1",
    body: "Please review",
    targets: [{ kind: "agent" as const, agent_id: "two" }],
    reply_expected: true,
  };
  const [sent, concurrent] = await Promise.all([
    one.rooms.publish("general", input),
    one.rooms.publish("general", input),
  ]);
  expect(concurrent.message.id).toBe(sent.message.id);
  expect((await one.rooms.publish("general", input)).message.id).toBe(
    sent.message.id,
  );
  const page = await two.inbox.fetch("two");
  expect(page.deliveries).toHaveLength(1);
  expect(page.deliveries[0].message.authority).toBe("peer-content");
  const recovered = await two.inbox.fetch("two");
  expect(recovered.deliveries[0].label).toContain("previously fetched");
  const d = page.deliveries[0];
  await two.inbox.ack("two", d.delivery.id, {
    ...page.binding,
    disposition: "accepted",
  });
  const reply = await two.rooms.publish("general", {
    client_op_id: d.reply_op_id,
    body: "Review accepted",
    targets: [{ kind: "agent", agent_id: "one" }],
  });
  expect(reply.message.chain_id).toBe(sent.message.chain_id);
  expect(reply.message.hop).toBe(1);
  expect((await one.inbox.fetch("one")).deliveries[0].message.body).toBe(
    "Review accepted",
  );
  expect(
    (
      await http(
        "/rooms/general/messages",
        input,
        one.run.token,
        one.k,
        one.run.context.participant_id ?? "missing-participant",
        { "Idempotency-Key": "forbidden" },
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await http("/rooms", undefined, owner, undefined, "operator", {
        "X-Tila-Conversation-Protocol": "2",
      })
    ).status,
  ).toBe(400);
  const forged = await http(
    "/inbox/two",
    undefined,
    owner,
    undefined,
    "operator",
    {
      "X-Tila-Conversation-Authority": JSON.stringify({
        runtime: two.run.context,
      }),
    },
  );
  expect(forged.status).toBe(403);
  const relay = await start("two", "relay");
  expect(
    (
      await http(
        "/inbox/two",
        undefined,
        relay.run.token,
        relay.k,
        relay.run.context.participant_id ?? "missing-participant",
      )
    ).status,
  ).toBe(403);
  const metadata = await json<{ deliveries: unknown[] }>(
    await http(
      "/dispatch/two/status",
      undefined,
      relay.run.token,
      relay.k,
      relay.run.context.participant_id ?? "missing-participant",
    ),
  );
  expect(JSON.stringify(metadata)).not.toContain("Please review");
  const history = await one.rooms.history("general", { limit: 1 });
  expect(history.has_more).toBe(true);
  expect(
    (await one.rooms.history("general", { cursor: history.cursor })).messages[0]
      .id,
  ).toBe(reply.message.id);
  async function mcp(session: typeof one) {
    const server = new McpServer({
      name: "conversation-fixture",
      version: "1",
    });
    registerConversationTools(
      server,
      {
        conversations: session.rooms,
        inbox: session.inbox,
        agents: createAgentMethods(session.client, project),
      },
      project,
    );
    const client = new McpClient({ name: "fixture", version: "1" });
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { server, client };
  }
  const firstMcp = await mcp(one);
  const secondMcp = await mcp(two);
  try {
    const publication = await firstMcp.client.callTool({
      name: "tila_room_publish",
      arguments: {
        room: "general",
        client_op_id: "mcp-operation",
        body: "MCP durable message",
        targets: [{ kind: "agent", agent_id: "two" }],
      },
    });
    expect(publication.isError).not.toBe(true);
    const fetched = await secondMcp.client.callTool({
      name: "tila_inbox_fetch",
      arguments: { agent: "two" },
    });
    expect(fetched.isError).not.toBe(true);
    const delivered = z
      .object({ result: ConversationInboxResponseSchema })
      .parse(fetched.structuredContent).result;
    expect(delivered.deliveries[0].message.body).toBe("MCP durable message");
    const accepted = await secondMcp.client.callTool({
      name: "tila_inbox_ack",
      arguments: {
        agent: "two",
        delivery_id: delivered.deliveries[0].delivery.id,
        ...delivered.binding,
        disposition: "accepted",
      },
    });
    expect(accepted.isError).not.toBe(true);
  } finally {
    await firstMcp.client.close();
    await secondMcp.client.close();
    await firstMcp.server.close();
    await secondMcp.server.close();
  }
  const replacement = await start("two");
  await json(
    await http(
      "/agents/two/bind",
      { ...attach, expected_epoch: 1 },
      replacement.run.token,
      replacement.k,
      replacement.run.context.participant_id ?? "missing-participant",
    ),
  );
  await expect(
    two.inbox.ack("two", d.delivery.id, {
      ...page.binding,
      disposition: "accepted",
    }),
  ).rejects.toMatchObject({ status: 409, code: "stale-binding" });
  await json(await http(`/runtime/runs/${one.run.context.run_id}/revoke`, {}));
  await expect(one.rooms.publish("general", input)).rejects.toMatchObject({
    status: 403,
  });
});
