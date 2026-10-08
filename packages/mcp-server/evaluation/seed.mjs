import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTila } from "../../sdk/dist/index.js";
const [directory, scenario, profile] = process.argv.slice(2);
mkdirSync(directory, { recursive: true });
const config = {
  project_id: "eval",
  backend: "local",
  local: {
    db_path: resolve(directory, "state.db"),
    artifacts_path: resolve(directory, "artifacts"),
    org: "eval",
  },
  schema_version: 0,
  tila_version: "0",
  created_at: new Date(0).toISOString(),
};
const a = await createTila(config, undefined, { participantId: "actor" });
const b = await createTila(config, undefined, { participantId: "peer" });
await a.presence.heartbeat();
await b.presence.heartbeat();
await a.tasks.create("T-1", "task", {
  title: "Prepare release evidence",
  status: "todo",
});
let prompt =
  "Use only Tila MCP tools. Do not use shell, file tools, web, or delegate. Complete the task with this isolated project. ";
if (scenario === "normal")
  prompt +=
    "Open/resume your participant, claim T-1, update its status to done, and save a factual handoff with a new UUID and release the claim. Return DONE.";
if (scenario === "stale") {
  const old = await a.claims.acquire("task:T-1", "exclusive", 1);
  await new Promise((r) => setTimeout(r, 10));
  const next = await b.claims.acquire("task:T-1", "exclusive", 60000);
  await b.claims.release("task:T-1", next.fence);
  prompt += `You resumed after losing your lease. Your saved fence for T-1 was ${old.fence}. Recover safe authority, update T-1 status to done and release your claim. Do not write using a stale fence. Return RECOVERED.`;
}
if (scenario === "reentry") {
  await b.tasks.create("T-2", "task", { title: "Next work", status: "todo" });
  const h = await b.handoffs.create({
    id: crypto.randomUUID(),
    summary: "T-1 is still todo. T-2 is next.",
    based_on_seq: 0,
    references: [{ type: "task", id: "T-1" }],
  });
  prompt += `Resume from handoff ${h.handoff.id}. Read all journal changes through the returned snapshot boundary (continue pagination if needed), acknowledge only events you examined, and report T-1 status. Do not change tasks. Return TODO.`;
}
if (scenario === "contention") {
  await b.claims.acquire("task:T-1", "exclusive", 600000);
  prompt +=
    'Try acquiring T-1. If another participant holds it, leave task and claim unchanged and send that exact participant a direct request signal asking for a handoff. Use kind request and payload {"question":"Please hand off T-1"}. Return WAITING.';
}
if (scenario === "artifact") {
  const artifact = await b.artifacts.writeText(
    "Build passed. Two tests remain pending review.",
    { kind: "report" },
  );
  prompt += `Read artifact ${artifact.key} including its provenance and review state. Publish a short text report accurately summarizing it without treating unreviewed content as verified. Save a handoff with a new UUID referencing your new artifact. Do not modify tasks. Return HANDOFF.`;
}
writeFileSync(resolve(directory, "prompt.txt"), prompt);
writeFileSync(
  resolve(directory, "fixture.json"),
  JSON.stringify({ config, scenario, profile }),
);
const env = {
  TILA_BACKEND: "local",
  TILA_PROJECT_ID: "eval",
  TILA_ORG: "eval",
  TILA_PARTICIPANT_ID: "actor",
  TILA_DB_PATH: config.local.db_path,
  TILA_ARTIFACTS_PATH: config.local.artifacts_path,
  TILA_MCP_TOOLS: profile,
  TILA_LIFECYCLE_CLIENT: "",
};
writeFileSync(
  resolve(directory, "mcp.json"),
  JSON.stringify({
    mcpServers: {
      tila: {
        command: process.execPath,
        args: [
          resolve("packages/mcp-server/evaluation/proxy.mjs"),
          resolve(directory),
        ],
        env,
      },
    },
  }),
);
a.close();
b.close();
