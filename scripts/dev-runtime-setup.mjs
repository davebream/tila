import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Called only by the explicitly destructive, local-only dev:setup command.
const root = resolve(import.meta.dirname, "..");
const home = resolve(root, ".tila/dev-auth");
const portProbe = createServer();
await new Promise((done, reject) => {
  portProbe.once("error", () =>
    reject(new Error("Stop the development server before dev:setup")),
  );
  portProbe.listen(8787, done);
});
await new Promise((done) => portProbe.close(done));
await rm(home, { recursive: true, force: true });
await mkdir(home, { recursive: true, mode: 0o700 });
const env = {
  ...process.env,
  TILA_HOME: home,
  TILA_API_TOKEN: "tila_dev_token_localonly",
  TILA_TOKEN: "",
  TILA_RUN_SOCKET: "",
  TILA_RUN_CAPABILITY: "",
  TILA_LIFECYCLE_KEY: "",
  CODEX_THREAD_ID: "",
  CI: "1",
};
const worker = spawn(
  "pnpm",
  [
    "--filter",
    "@tila/worker",
    "exec",
    "wrangler",
    "dev",
    "--local",
    "--port",
    "8787",
    "--config",
    "wrangler.dev.toml",
  ],
  { cwd: root, env, stdio: "ignore", detached: true },
);
let exited = false;
worker.once("exit", () => {
  exited = true;
});
async function cli(args, input) {
  const child = spawn(
    "bun",
    [
      "--tsconfig-override",
      resolve(root, "tsconfig.json"),
      resolve(root, "packages/cli/src/index.ts"),
      "--instance",
      "http://localhost:8787",
      "--project",
      "dev-project",
      "--json",
      "--non-interactive",
      ...args,
    ],
    { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stderr.resume();
  child.stdin.end(input);
  const status = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("exit", done);
  });
  if (status !== 0)
    throw new Error(
      `Local runtime setup failed during ${args.slice(0, 2).join(" ")}; no credentials were printed`,
    );
  const result = JSON.parse(Buffer.concat(chunks).toString());
  return result.result ?? result;
}
try {
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (exited || Date.now() > deadline)
      throw new Error(
        "Local Worker did not start; stop any existing development server before dev:setup",
      );
    try {
      const response = await fetch("http://localhost:8787/api/runtime/info", {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) break;
    } catch {}
    await delay(200);
  }
  const invitation = await cli([
    "machine",
    "authorize",
    "--name",
    "Contributor development",
  ]);
  await cli(
    [
      "machine",
      "enroll",
      "--name",
      "Contributor development",
      "--file-store",
      resolve(home, "secrets"),
      "--invitation-stdin",
    ],
    invitation.invitation,
  );
  console.log(
    "Local runtime enrollment is ready; MCP uses isolated development credentials.",
  );
} finally {
  if (worker.pid && !exited) process.kill(-worker.pid, "SIGTERM");
}
