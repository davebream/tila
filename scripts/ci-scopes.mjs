import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Scopes can let Mergify skip queue CI. Missing information must broaden them.
export function selectScopes({
  base,
  head,
  expectedHead,
  cwd = process.cwd(),
  runTurbo = (env) =>
    spawnSync(
      "node",
      [
        "scripts/turbo.mjs",
        "run",
        "typecheck",
        "test",
        "--affected",
        "--dry=json",
      ],
      { cwd, env, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
    ),
}) {
  const full = (reason) => ({
    mode: "full",
    base,
    head,
    scopes: [],
    all_scopes: true,
    reason,
  });
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? "")))
      return full("Missing or invalid comparison commits");
    if (expectedHead && head !== expectedHead)
      return full("Comparison head does not match the pull request revision");
    for (const sha of [base, head]) git("cat-file", "-e", `${sha}^{commit}`);
    git("merge-base", "--is-ancestor", head, "HEAD");

    // Disable rename detection so both the removed and added paths are covered.
    const files = git(
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      `${base}...${head}`,
    )
      .split("\0")
      .filter(Boolean);
    if (!files.length) return full("No changed files detected");
    const manifests = new Map();
    for (const directory of readdirSync(join(cwd, "packages"), {
      withFileTypes: true,
    })) {
      if (!directory.isDirectory()) continue;
      const path = `packages/${directory.name}`;
      const manifest = JSON.parse(
        readFileSync(join(cwd, path, "package.json"), "utf8"),
      );
      if (
        typeof manifest.name !== "string" ||
        !/^(@[a-z0-9-]+\/)?[a-z0-9._-]+$/.test(manifest.name)
      )
        return full("Invalid workspace package name");
      manifests.set(path, manifest.name);
    }
    const changed = new Set();
    for (const file of files) {
      const parts = file.split("/");
      const name = manifests.get(parts.slice(0, 2).join("/"));
      // Root files, docs, scripts, CI, new/deleted packages and manifest changes
      // can affect consumers beyond Turbo's package graph. Keep them barriers.
      if (
        parts[0] !== "packages" ||
        parts.length < 3 ||
        !name ||
        parts[2] === "package.json"
      )
        return full("Shared, unknown, or package-manifest files changed");
      changed.add(name);
    }

    const result = runTurbo({
      ...process.env,
      TURBO_SCM_BASE: base,
      TURBO_SCM_HEAD: head,
    });
    if (result.status !== 0) return full("Turbo affected selection failed");
    const dry = JSON.parse(result.stdout);
    const known = new Set(manifests.values());
    if (
      !Array.isArray(dry.packages) ||
      !dry.packages.length ||
      dry.packages.length > 10000 ||
      !dry.packages.every((name) => known.has(name)) ||
      !Array.isArray(dry.tasks)
    )
      return full("Invalid or empty Turbo selection");
    const scopes = [...new Set(dry.packages)].sort();
    if (![...changed].every((name) => scopes.includes(name)))
      return full("Turbo omitted a changed package");
    return {
      mode: "observe",
      base,
      head,
      scopes,
      all_scopes: false,
      tasks: dry.tasks.map((task) => task.taskId),
    };
  } catch {
    return full(
      "Scope detection failed; treating this revision as affecting everything",
    );
  }
}
