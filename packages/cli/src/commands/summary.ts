import { defineCommand } from "citty";
import { resolveContext } from "../context";
import { jsonArg, outputText, printJson } from "../lib/output";

export default defineCommand({
  meta: { name: "summary", description: "Show project summary" },
  args: {
    ...jsonArg,
  },
  async run({ args }) {
    const { summary } = await resolveContext();
    const p = await summary.getSummary();
    if (args.json) {
      printJson(p);
      return;
    }
    outputText(
      `Entities: ${p.entity_count} (ready: ${p.ready_count}, active claims: ${p.active_claims})`,
    );
    outputText(
      `Types: ${
        Object.entries(p.entity_counts)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ") || "none"
      }`,
    );
    outputText(
      `Statuses: ${
        Object.entries(p.status_counts)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ") || "none"
      }`,
    );
    outputText(`Online: ${p.online_participants.join(", ") || "none"}`);
    outputText(`Token estimate: ${p.token_estimate}`);
    if (p.recent_events.length > 0) {
      outputText("Recent events:");
      for (const e of p.recent_events.slice(0, 5)) {
        outputText(
          `  ${e.kind}  ${e.resource}  by ${e.principal_id}/${e.participant_id}`,
        );
      }
    }
  },
});
