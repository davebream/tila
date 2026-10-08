import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";

mkdirSync(".ci-reports", { recursive: true });
let selection;
try {
  const base = process.env.CI_BASE_SHA;
  if (!base || !/^[a-f0-9]{40}$/.test(base))
    throw new Error("No valid PR base SHA");
  execFileSync("git", ["cat-file", "-e", `${base}^{commit}`]);
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const result = spawnSync(
    "node",
    [
      "scripts/turbo.mjs",
      "run",
      "typecheck",
      "test",
      "--affected",
      "--dry=json",
    ],
    {
      env: { ...process.env, TURBO_SCM_BASE: base, TURBO_SCM_HEAD: head },
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || "Affected selection failed");
  const dry = JSON.parse(result.stdout);
  selection = {
    mode: "observe",
    base,
    head,
    packages: dry.packages,
    tasks: dry.tasks.map((task) => task.taskId),
  };
} catch (error) {
  selection = { mode: "full", reason: error.message };
}
writeFileSync(
  ".ci-reports/selection.json",
  `${JSON.stringify(selection, null, 2)}\n`,
);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `\nAffected selection: **${selection.mode}**. Full validation remains authoritative.\n\n\`\`\`json\n${JSON.stringify(selection, null, 2)}\n\`\`\`\n`,
  );
console.log(JSON.stringify(selection));
