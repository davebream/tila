import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";
import { findTilaDir, loadConfigFile } from "../config";
import { assertExplicitInstanceTarget } from "../lib/explicit-instance";
import { getGlobalFlags } from "../lib/global-flags";
import { exit } from "../lib/output";
import * as p from "../lib/prompts";

export default defineCommand({
  meta: {
    name: "disconnect",
    description: "Remove local credentials (keep project config)",
  },
  async run() {
    const tilaDir = findTilaDir();
    if (!tilaDir) {
      p.log.error("No .tila/ directory found.");
      exit(1);
    }

    // An explicit --instance must be this project's deployment before its
    // credentials are deleted. The config is read only then, so disconnect
    // still works without --instance when config.toml is unparseable.
    if (getGlobalFlags().instance !== undefined)
      await assertExplicitInstanceTarget(
        loadConfigFile(join(tilaDir, "config.toml")),
      );

    const credentialFiles = [".env", ".session", "github-token-cache.json"];
    let removed = 0;

    for (const file of credentialFiles) {
      const filePath = join(tilaDir, file);
      if (existsSync(filePath)) {
        unlinkSync(filePath);
        removed++;
      }
    }

    if (removed === 0) {
      p.log.info("No credential files found — already disconnected.");
    } else {
      p.log.success("Disconnected from project. Re-join with `tila init`.");
    }
  },
});
