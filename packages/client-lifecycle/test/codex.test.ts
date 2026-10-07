import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CodexObserver } from "../src/codex";
it("checks default-daemon status without resuming or subscribing to a thread", async () => {
  const root = mkdtempSync(join(tmpdir(), "tila-codex-observer-"));
  const executable = join(root, "codex");
  const log = join(root, "requests.jsonl");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(log)}, line+'\\n');
  if (request.id !== undefined) console.log(JSON.stringify({id: request.id, result: request.method === 'initialize' ? {} : {thread:{status:{type:request.params.threadId}}}}));
});
`,
    { mode: 0o700 },
  );
  const observer = new CodexObserver(executable);
  try {
    expect(await observer.alive("active")).toBe(true);
    expect(await observer.alive("idle")).toBe(true);
    expect(await observer.alive("notLoaded")).toBe(false);
    const requests = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(requests[0]).toEqual(["app-server", "proxy"]);
    expect(requests.slice(1).map((row) => row.method)).toEqual([
      "initialize",
      "initialized",
      "thread/read",
      "thread/read",
      "thread/read",
    ]);
    expect(requests.at(-1).params.includeTurns).toBe(false);
  } finally {
    observer.close();
    rmSync(root, { recursive: true, force: true });
  }
});
