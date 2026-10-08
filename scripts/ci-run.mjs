import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [label, command, ...args] = process.argv.slice(2);
if (!label || !/^[a-z0-9-]+$/.test(label) || !command) {
  throw new Error("Usage: ci-run.mjs <label> <command> [arguments...]");
}
const directory = process.env.CI_REPORT_DIR || ".ci-reports";
mkdirSync(directory, { recursive: true });
const started = Date.now();
const log = join(directory, `${label}.log`);
const child = spawn(command, args, {
  stdio: ["inherit", "pipe", "pipe"],
  env: process.env,
});
for (const [stream, destination] of [
  [child.stdout, process.stdout],
  [child.stderr, process.stderr],
]) {
  stream.on("data", (chunk) => {
    appendFileSync(log, chunk);
    destination.write(chunk);
  });
}
child.on("error", (error) => {
  appendFileSync(log, `${error.message}\n`);
});
child.on("close", (code, signal) => {
  const elapsed = (Date.now() - started) / 1000;
  const result = { label, seconds: elapsed, exitCode: code, signal };
  appendFileSync(
    join(directory, "timings.jsonl"),
    `${JSON.stringify(result)}\n`,
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `| ${label} | ${elapsed.toFixed(1)}s | ${code === 0 ? "passed" : "failed"} |\n`,
    );
  }
  process.exitCode = code ?? 1;
});
