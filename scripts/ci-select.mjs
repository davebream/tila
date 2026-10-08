import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { selectScopes } from "./ci-scopes.mjs";

mkdirSync(".ci-reports", { recursive: true });
const selection = selectScopes({
  base: process.env.CI_BASE_SHA,
  head: process.env.CI_HEAD_SHA,
  expectedHead: process.env.CI_PR_HEAD_SHA,
});
if (process.env.GITHUB_OUTPUT)
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `scopes_payload=${JSON.stringify({
      head_ref: process.env.CI_PR_HEAD_SHA,
      scopes: selection.scopes,
      all_scopes: selection.all_scopes,
    })}\n`,
  );
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
