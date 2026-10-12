import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { durableWrite } from "./process-adapter.mjs";

const directory = process.argv[2];
const intent = JSON.parse(
  await readFile(join(directory, "intent.json"), "utf8"),
);
const statePath = join(directory, "state.json");
const running = () => ({
  state: "running",
  attempt_id: intent.attempt_id,
  session: intent.session,
  updated_at: Date.now(),
});
await durableWrite(statePath, running());
const child = spawn(intent.executable, intent.args, {
  cwd: intent.worktree,
  shell: false,
  detached: true,
  stdio: "ignore",
});
let cancelled = false;
let finished = false;
let writing = Promise.resolve();
const timer = setInterval(() => {
  writing = writing.then(async () => {
    if (finished) return;
    await durableWrite(statePath, running());
    try {
      await readFile(join(directory, "cancel.json"));
      if (!cancelled && !finished) {
        cancelled = true;
        process.kill(-child.pid, "SIGTERM");
      }
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
    }
  });
}, 250);
const result = await new Promise((resolve) => {
  child.once("error", (error) =>
    resolve({ status: "failure", reason: error.message }),
  );
  child.once("exit", (code, signal) =>
    resolve({
      status: cancelled ? "cancelled" : code === 0 ? "success" : "failure",
      reason: `Foreground command exited: code=${code}, signal=${signal}`,
    }),
  );
});
finished = true;
clearInterval(timer);
await writing;
await durableWrite(statePath, {
  state: "stopped",
  attempt_id: intent.attempt_id,
  outcome: {
    ...result,
    evidence: [statePath],
    execution_stopped: true,
    unresolved_external_execution: false,
  },
});
