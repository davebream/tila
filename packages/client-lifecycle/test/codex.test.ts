import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CodexObserver } from "../src/codex";
import { readProfileAccount } from "../src/profiles";
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

it.each(["matching", "different", "missing"])(
  "verifies plain CLI credentials only when the returned home is matching (%s)",
  async (home) => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "tila-codex-account-")),
    );
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
  if (request.id === undefined) return;
  const result = request.method === 'initialize'
    ? ${JSON.stringify(home === "missing" ? {} : { codexHome: home === "matching" ? root : tmpdir() })}
    : {account:{type:'chatgpt',email:'account@example.test'}};
  console.log(JSON.stringify({id:request.id,result}));
});
`,
      { mode: 0o700 },
    );
    try {
      const account = await readProfileAccount({
        id: "plain-codex",
        harness: "codex",
        launcher: executable,
        config_dir: root,
        credential_store: "auto",
        env_allowlist: [],
        revision: 1,
        account_ref: "unused",
      });
      expect(account).toBe(home === "matching" ? "account@example.test" : null);
      const requests = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(requests[0]).toEqual(["app-server", "--stdio"]);
      expect(requests.slice(1).map((row) => row.method)).toEqual(
        home === "matching"
          ? ["initialize", "initialized", "account/read"]
          : ["initialize"],
      );
      if (home === "matching")
        expect(requests.at(-1).params).toEqual({ refreshToken: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it("never treats a credential probe as a live session observer", async () => {
  const observer = new CodexObserver("unused", {}, "credentials");
  await expect(observer.alive("session")).rejects.toThrow(
    "cannot observe live sessions",
  );
});
