import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTila } from "../../sdk/dist/index.js";
const base = resolve(process.argv[2] ?? ".context/mcp-evaluation");
const latest = new Map();
for (const name of readdirSync(base).sort()) {
  const dir = resolve(base, name);
  if (!existsSync(resolve(dir, "run.json")) || !/-\d+$/.test(name)) continue;
  const run = JSON.parse(readFileSync(resolve(dir, "run.json")));
  latest.set([run.client, run.profile, run.scenario].join("/"), {
    ...run,
    dir,
  });
}
const results = [];
for (const run of latest.values()) {
  const events = existsSync(resolve(run.dir, "mcp.jsonl"))
    ? readFileSync(resolve(run.dir, "mcp.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse)
    : [];
  // Fixture leases are evaluated at the recorded end of the client interaction,
  // so rescoring an unchanged database tomorrow produces the same result.
  const evaluatedAt = run.finished_at ?? events.at(-1)?.time;
  if (!Number.isFinite(evaluatedAt))
    throw new Error(`Missing run time: ${run.dir}`);
  const realNow = Date.now;
  Date.now = () => evaluatedAt;
  const fixture = JSON.parse(readFileSync(resolve(run.dir, "fixture.json")));
  const api = await createTila(fixture.config, undefined, {
    participantId: "actor",
  });
  const peer = await createTila(fixture.config, undefined, {
    participantId: "peer",
  });
  const task = (await api.tasks.get("T-1")).entity;
  const claim = (await api.claims.get("task:T-1")).claim;
  const handoffs = (await api.handoffs.list()).handoffs;
  const cursor = (await api.journal.getCursor()).cursor.seq;
  const inbox = (await peer.signals.inbox()).signals;
  const calls = events
    .filter(
      (e) => e.direction === "request" && e.message.method === "tools/call",
    )
    .map((e) => e.message);
  const responses = new Map(
    events
      .filter((e) => e.direction === "response")
      .map((e) => [e.message.id, e.message]),
  );
  const observed = new Set();
  let invalid = 0;
  let errors = 0;
  for (const c of calls) {
    const r = responses.get(c.id)?.result;
    if (!r || r.isError) {
      errors++;
      if (r?.structuredContent?.error?.code !== "already-held") invalid++;
      continue;
    }
    const result = r?.structuredContent?.result;
    for (const event of result?.changes?.events ?? result?.events ?? [])
      observed.add(event.seq);
  }
  let contiguous = 0;
  while (observed.has(contiguous + 1)) contiguous++;
  let success = false;
  if (run.scenario === "normal")
    success = task.data.status === "done" && !claim && handoffs.length > 0;
  if (run.scenario === "stale") success = task.data.status === "done" && !claim;
  if (run.scenario === "reentry")
    success = task.data.status === "todo" && cursor > 0 && cursor <= contiguous;
  if (run.scenario === "contention")
    success =
      task.data.status === "todo" &&
      claim?.participant_id === "peer" &&
      inbox.some((s) => s.kind === "request");
  if (run.scenario === "artifact") {
    const references = handoffs
      .flatMap((h) => h.references)
      .filter((r) => r.type === "artifact");
    for (const ref of references) {
      const r = await api.artifacts.readText(ref.key);
      if (
        r.pointer?.provenance?.participant_id === "actor" &&
        r.pointer?.review?.state === "unreviewed"
      )
        success = task.data.status === "todo";
    }
  }
  const stream = readFileSync(resolve(run.dir, "client.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  let tokens = null;
  let model = null;
  let usage = null;
  if (run.client === "claude") {
    const end = stream.findLast((e) => e.type === "result");
    usage = end?.usage;
    model =
      stream.find((e) => e.type === "system" && e.subtype === "init")?.model ??
      null;
    if (usage)
      tokens =
        (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.output_tokens ?? 0);
  } else {
    usage = stream.findLast((e) => e.type === "turn.completed")?.usage;
    if (usage) tokens = usage.input_tokens + usage.output_tokens;
  }
  results.push({
    ...run,
    evaluated_at: evaluatedAt,
    success: success && run.exit === 0,
    calls: calls.length,
    errors,
    invalid,
    selection_accuracy: calls.length
      ? (calls.length - invalid) / calls.length
      : 0,
    tokens,
    model,
    usage,
  });
  api.close();
  peer.close();
  Date.now = realNow;
}
writeFileSync(
  resolve(base, "results.json"),
  `${JSON.stringify(results, null, 2)}\n`,
);
for (const client of ["claude", "codex"])
  for (const profile of ["workflow", "all"]) {
    const group = results.filter(
      (r) => r.client === client && r.profile === profile,
    );
    console.log(
      JSON.stringify({
        client,
        profile,
        runs: group.length,
        success: group.filter((r) => r.success).length,
        calls: group.reduce((a, r) => a + r.calls, 0),
        invalid: group.reduce((a, r) => a + r.invalid, 0),
        tokens: group.reduce((a, r) => a + (r.tokens ?? 0), 0),
        models: [...new Set(group.map((r) => r.model))],
      }),
    );
  }
