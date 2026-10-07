import { defineCommand } from "citty";
import { resolveContext } from "../context";
import {
  diagnostic,
  exit,
  jsonArg,
  outputText,
  printJson,
  renderTable,
} from "../lib/output";

const listCommand = defineCommand({
  meta: { name: "list", description: "List all active claims" },
  args: {
    ...jsonArg,
  },
  async run({ args }) {
    const { coordination } = await resolveContext();
    const claims = await coordination.listClaims();
    if (args.json) {
      printJson({ ok: true, claims });
      return;
    }
    if (claims.length === 0) {
      outputText("No active claims.");
      return;
    }
    renderTable(
      claims.map((c) => ({
        resource: c.resource,
        principal: c.principal_id,
        participant: c.participant_id,
        machine: c.environment.machine ?? "",
        mode: c.mode,
        fence: c.fence,
        ttl: `${Math.max(0, Math.round((c.expires_at - Date.now()) / 1000))}s`,
      })),
      [
        { key: "resource", label: "Resource" },
        { key: "principal", label: "Principal" },
        { key: "participant", label: "Participant" },
        { key: "machine", label: "Environment" },
        { key: "mode", label: "Mode" },
        { key: "fence", label: "Fence" },
        { key: "ttl", label: "TTL" },
      ],
    );
  },
});

export default defineCommand({
  meta: { name: "state", description: "Show claim state" },
  args: {
    resource: {
      type: "positional",
      description: "Resource identifier (e.g. task:T-abc123)",
      required: false,
    },
    ...jsonArg,
  },
  subCommands: {
    list: listCommand,
  },
  async run({ args }) {
    if (!args.resource) {
      diagnostic("Usage: tila state <resource> | tila state list");
      exit(1);
    }
    const { coordination } = await resolveContext();
    const claim = await coordination.state(args.resource as string);
    if (args.json) {
      // Re-wrap in { ok, claim } envelope for JSON output parity
      printJson({ ok: true, claim });
      return;
    }
    if (!claim) {
      outputText(`${args.resource}: unclaimed`);
      return;
    }
    const ttlSec = Math.max(
      0,
      Math.round((claim.expires_at - Date.now()) / 1000),
    );
    outputText(`${args.resource}:`);
    outputText(`  principal:   ${claim.principal_id}`);
    outputText(`  participant: ${claim.participant_id}`);
    if (claim.environment.machine) {
      outputText(`  machine:     ${claim.environment.machine}`);
    }
    outputText(`  mode:    ${claim.mode}`);
    outputText(`  fence:   ${claim.fence}`);
    outputText(`  ttl:     ${ttlSec}s`);
    outputText(`  expires: ${new Date(claim.expires_at).toISOString()}`);
  },
});
