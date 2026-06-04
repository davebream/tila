import { defineCommand } from "citty";
import { resolveContext } from "../context";
import { printJson } from "../lib/output";

export default defineCommand({
  meta: { name: "summary", description: "Show project summary" },
  args: {
    json: {
      type: "boolean",
      description: "Output as JSON",
      default: false,
    },
  },
  async run({ args }) {
    const { summary } = await resolveContext();
    const p = await summary.getSummary();
    if (args.json) {
      printJson(p);
      return;
    }
    console.log(
      `Entities: ${p.entity_count} (ready: ${p.ready_count}, active claims: ${p.active_claims})`,
    );
    console.log(
      `Types: ${
        Object.entries(p.entity_counts)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ") || "none"
      }`,
    );
    console.log(
      `Statuses: ${
        Object.entries(p.status_counts)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ") || "none"
      }`,
    );
    console.log(`Online: ${p.online_machines.join(", ") || "none"}`);
    console.log(`Token estimate: ${p.token_estimate}`);
    if (p.recent_events.length > 0) {
      console.log("Recent events:");
      for (const e of p.recent_events.slice(0, 5)) {
        console.log(`  ${e.kind}  ${e.resource}  by ${e.actor}`);
      }
    }
  },
});
