import { defineCommand } from "citty";
import { findConfig } from "../config";
import { openInBrowser } from "../lib/browser";

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
      console.error("No tila project found. Run 'tila init' first.");
      process.exit(1);
    }

    if (config.backend === "local" && !config.worker_url) {
      console.error(
        "This project uses a local backend with no worker_url configured. " +
          "Set worker_url in .tila/config.toml to use 'tila open'.",
      );
      process.exit(1);
    }

    if (!config.worker_url) {
      console.error(
        "No worker_url found in config. Set worker_url in .tila/config.toml.",
      );
      process.exit(1);
    }

    if (typedArgs.print) {
      console.log(config.worker_url);
      return;
    }

    openInBrowser(config.worker_url);
  },
});
