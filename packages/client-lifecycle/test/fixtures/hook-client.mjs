import { spawn } from "node:child_process";
const [repo, cwd, sessionId] = process.argv.slice(2);
async function hook(hook_event_name) {
  const child = spawn(
    "bun",
    [
      "--tsconfig-override",
      `${repo}/tsconfig.json`,
      `${repo}/packages/cli/src/index.ts`,
      "lifecycle",
      "hook",
      "--client",
      "claude-code",
    ],
    { cwd, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(
    JSON.stringify({ session_id: sessionId, cwd, hook_event_name }),
  );
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(stderr)),
    );
  });
  return stdout;
}
process.send(await hook("SessionStart"));
process.on("message", async () => {
  await hook("SessionEnd");
  process.exit(0);
});
