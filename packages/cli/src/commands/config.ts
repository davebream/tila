import { defineCommand } from "citty";
import { findConfig } from "../config";
import { printJson, printJsonError } from "../lib/output";

export default defineCommand({
  meta: { name: "config", description: "View project configuration" },
  subCommands: {
    get: defineCommand({
      meta: { name: "get", description: "Get a config value" },
      args: {
        key: {
          type: "positional",
          description: "Config key (dot-separated)",
          required: true,
        },
        json: {
          type: "boolean",
          description: "Output as JSON",
          default: false,
        },
      },
      run({ args }) {
        const config = findConfig();
        if (!config) {
          if (args.json) {
            printJsonError("No tila project found", "NOT_FOUND");
          }
          console.error("No tila project found. Run 'tila init' first.");
          process.exit(1);
        }
        const parts = (args.key as string).split(".");
        let value: unknown = config;
        for (const part of parts) {
          if (value && typeof value === "object" && part in value) {
            value = (value as Record<string, unknown>)[part];
          } else {
            if (args.json) {
              printJsonError(`Key not found: ${args.key}`, "KEY_NOT_FOUND");
            }
            console.error(`Key not found: ${args.key}`);
            process.exit(1);
          }
        }
        if (args.json) {
          printJson({ key: args.key as string, value });
          return;
        }
        console.log(
          typeof value === "object"
            ? JSON.stringify(value, null, 2)
            : String(value),
        );
      },
    }),
    set: defineCommand({
      meta: {
        name: "set",
        description: "Set a config value (writes to .tila/config.toml)",
      },
      args: {
        key: { type: "positional", description: "Config key", required: true },
        value: {
          type: "positional",
          description: "Config value",
          required: true,
        },
      },
      run() {
        // Config set is a local-only operation that modifies .tila/config.toml.
        // Full implementation requires TOML serialization -- deferred to init flow.
        console.error(
          "'tila config set' is not yet implemented. Edit .tila/config.toml directly.",
        );
        process.exit(1);
      },
    }),
  },
});
