import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
const directory = process.argv[2];
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const child = spawn(process.execPath, [entry], {
  env: process.env,
  stdio: ["pipe", "pipe", "inherit"],
});
const log = (direction, line) =>
  appendFileSync(
    resolve(directory, "mcp.jsonl"),
    `${JSON.stringify({ direction, time: Date.now(), message: JSON.parse(line) })}\n`,
  );
let calls = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.method === "tools/call" && ++calls > 35) {
      child.kill();
      process.exit(2);
    }
    log("request", line);
    child.stdin.write(`${line}\n`);
  } catch {}
});
createInterface({ input: child.stdout }).on("line", (line) => {
  log("response", line);
  process.stdout.write(`${line}\n`);
});
process.stdin.on("end", () => child.stdin.end());
child.on("exit", (code) => process.exit(code ?? 1));
process.on("SIGTERM", () => {
  child.kill();
  process.exit(143);
});
