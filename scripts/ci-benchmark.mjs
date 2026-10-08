import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

mkdirSync(".ci-reports", { recursive: true });
const results = [];
for (const [concurrency, workers] of [
  [null, null],
  [2, 1],
  [2, 2],
  [4, 1],
  [4, 2],
]) {
  for (let repeat = 0; repeat < 3; repeat++) {
    const start = performance.now();
    let passed = true;
    for (const task of ["typecheck", "test"]) {
      const args = ["scripts/turbo.mjs", "run", task, "--force", "--summarize"];
      if (concurrency) args.push(`--concurrency=${concurrency}`);
      const env = { ...process.env };
      if (workers) env.VITEST_MAX_WORKERS = String(workers);
      else env.VITEST_MAX_WORKERS = undefined;
      if (
        spawnSync(process.execPath, args, { env, stdio: "inherit" }).status !==
        0
      ) {
        passed = false;
        break;
      }
    }
    results.push({
      concurrency,
      workers,
      repeat,
      passed,
      seconds: (performance.now() - start) / 1000,
    });
    writeFileSync(
      ".ci-reports/concurrency.json",
      `${JSON.stringify(results, null, 2)}\n`,
    );
  }
}
// No automatic tuning: hosted-runner evidence is reviewed alongside these results.
if (results.some((result) => !result.passed)) process.exitCode = 1;
