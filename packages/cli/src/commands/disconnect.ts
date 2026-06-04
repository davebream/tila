import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { defineCommand } from "citty";
import { findTilaDir } from "../config";

export default defineCommand({
  meta: {
    name: "disconnect",
    description: "Remove local credentials (keep project config)",
  },
  async run() {
    const tilaDir = findTilaDir();
    if (!tilaDir) {
      p.log.error("No .tila/ directory found.");
      process.exit(1);
    }

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
