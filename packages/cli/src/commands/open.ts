import { defineCommand } from "citty";
import { findConfig } from "../config";
import { openInBrowser } from "../lib/browser";
import { diagnostic, exit, outputText } from "../lib/output";

export default defineCommand({
  meta: {
    name: "open",
    description: "Open the tila dashboard in your browser",
  },
  args: {
    print: {
      type: "boolean",
      description: "Print the dashboard URL instead of opening it",
      default: false,
    },
  },
  run({ args }) {
    const typedArgs = args as unknown as { print: boolean };
    const config = findConfig();
    if (!config) {
      diagnostic("No tila project found. Run 'tila init' first.");
      exit(1);
    }

    if (config.backend === "local" && !config.worker_url) {
      diagnostic(
        "This project uses a local backend with no worker_url configured. " +
          "Set worker_url in .tila/config.toml to use 'tila open'.",
      );
      exit(1);
    }

    if (!config.worker_url) {
      diagnostic(
        "No worker_url found in config. Set worker_url in .tila/config.toml.",
      );
      exit(1);
    }

    if (typedArgs.print) {
      outputText(config.worker_url);
      return;
    }

    openInBrowser(config.worker_url);
  },
});
