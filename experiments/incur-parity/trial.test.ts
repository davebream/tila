import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("CLI JSON contract and standalone Bun binary", () => {
  const args = ["reentry", "--participant", "one", "--json"];
  const expected = { ok: true, participant: "one", claims: [] };
  assert.deepEqual(
    JSON.parse(
      execFileSync(process.execPath, ["--import", "tsx", "trial.ts", ...args], {
        encoding: "utf8",
      }),
    ),
    expected,
  );
  execFileSync(
    "bun",
    ["build", "--compile", "trial.ts", "--outfile", "dist/tila-trial"],
    { stdio: "pipe" },
  );
  assert.deepEqual(
    JSON.parse(execFileSync("./dist/tila-trial", args, { encoding: "utf8" })),
    expected,
  );
});

test("MCP names, explicit identity, fence protection, and adoption blockers", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "trial.ts", "--mcp"],
    stderr: "pipe",
  });
  const client = new Client({ name: "parity-trial", version: "1" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "tila_claim_acquire",
      "tila_claim_release",
      "tila_reentry",
    ]);
    assert.equal(tools[0].inputSchema.properties?.project, undefined); // #229
    const call = (
      name: string,
      args: Record<string, unknown>,
      sessionId?: string,
    ) =>
      client.callTool({
        name,
        arguments: args,
        ...(sessionId ? { _meta: { sessionId } } : {}),
      });
    assert.deepEqual(
      (
        await call("tila_claim_acquire", {
          resource: "task",
          participant: "one",
        })
      ).structuredContent,
      { ok: true, participant: "one", fence: 1 },
    );
    const conflict = await call("tila_claim_acquire", {
      resource: "task",
      participant: "two",
    });
    assert.equal(conflict.isError, true);
    assert.equal(JSON.stringify(conflict).includes("CLAIM_CONFLICT"), false); // #234
    const stale = await call("tila_claim_release", {
      resource: "task",
      participant: "one",
      fence: 0,
    });
    assert.equal(stale.isError, true);
    assert.equal(JSON.stringify(stale).includes("STALE_FENCE"), false);
    assert.equal(
      (
        await call("tila_claim_release", {
          resource: "task",
          participant: "two",
          fence: 1,
        })
      ).isError,
      true,
    );
    const [one, two] = await Promise.all([
      call("tila_reentry", { participant: "one" }),
      call("tila_reentry", { participant: "two" }),
    ]);
    assert.deepEqual(one.structuredContent, {
      ok: true,
      participant: "one",
      claims: ["task"],
    });
    assert.deepEqual(two.structuredContent, {
      ok: true,
      participant: "two",
      claims: [],
    });
    const native = await call("tila_reentry", {}, "native-session");
    assert.equal(
      (native.structuredContent as { participant: string }).participant,
      "fallback",
    );
    assert.deepEqual(
      (
        await call("tila_claim_release", {
          resource: "task",
          participant: "one",
          fence: 1,
        })
      ).structuredContent,
      { ok: true },
    );
  } finally {
    await client.close();
  }
});
