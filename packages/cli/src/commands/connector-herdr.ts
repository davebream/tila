import {
  ConnectorStore,
  HERDR_CONTRACT,
  HERDR_SUPPORT,
  controlRequest,
  requireHerdrSupport,
} from "@tila/connector";
import { defineCommand } from "citty";
import { printJson } from "../lib/output";

async function status() {
  let connector: unknown = null;
  try {
    connector = await controlRequest(new ConnectorStore(), {
      action: "status",
    });
  } catch {
    /* No unauthenticated fallback to the running connector. */
  }
  return { contract: HERDR_CONTRACT, support: HERDR_SUPPORT, connector };
}
export default defineCommand({
  meta: {
    name: "herdr",
    description:
      "Gated Herdr integration and authenticated connector inspection",
  },
  subCommands: {
    status: defineCommand({
      async run() {
        printJson(await status());
      },
    }),
    reconcile: defineCommand({
      async run() {
        printJson(await status());
      },
    }),
    register: defineCommand({
      async run() {
        requireHerdrSupport();
      },
    }),
    open: defineCommand({
      async run() {
        requireHerdrSupport();
      },
    }),
  },
});
