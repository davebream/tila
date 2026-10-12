// Assemble the deploy payload that `bun build --compile --asset deploy-payload`
// embeds into every release binary. `tila deploy` and `tila infra provision`
// stage it under ~/.tila/cache (packages/cli/src/lib/deploy-payload.ts).
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "./release-common.mjs";

const WORKER_CODE = new Set([".js", ".mjs", ".wasm"]);
// Wrangler's dry-run output that is not part of the deployable Worker.
const WORKER_IGNORED = new Set(["bundle-meta.json", "README.md"]);
// A UI built with a dev `.env.local` would call the developer's machine.
const LOCAL_API = /localhost:8787|127\.0\.0\.1:8787/;

function walk(directory, base = directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path, base));
    else if (entry.isFile())
      files.push(relative(base, path).split(sep).join("/"));
  }
  return files.sort();
}

export function assemblePayload({
  workerDir,
  uiDir,
  migrationsDir,
  output,
  version,
}) {
  const sources = [];

  const workerFiles = walk(workerDir).filter((file) => {
    if (file.endsWith(".map") || WORKER_IGNORED.has(file)) return false;
    if (!WORKER_CODE.has(extname(file)))
      throw new Error(`Unexpected file in Worker bundle: ${file}`);
    return true;
  });
  if (!workerFiles.includes("index.js"))
    throw new Error(`Worker bundle has no index.js in ${workerDir}`);
  for (const file of workerFiles)
    sources.push([`worker/${file}`, join(workerDir, file)]);

  const uiFiles = walk(uiDir);
  if (!uiFiles.includes("index.html"))
    throw new Error(`UI build has no index.html in ${uiDir}`);
  for (const file of uiFiles) {
    const path = join(uiDir, file);
    if (LOCAL_API.test(readFileSync(path, "latin1")))
      throw new Error(
        `UI build points at a local API (${file}). Rebuild it with VITE_API_URL="".`,
      );
    sources.push([`ui/dist/${file}`, path]);
  }

  const migrations = walk(migrationsDir).filter((file) =>
    file.endsWith(".sql"),
  );
  if (migrations.length === 0)
    throw new Error(`No D1 migrations in ${migrationsDir}`);
  for (const file of migrations)
    sources.push([`migrations/global/${file}`, join(migrationsDir, file)]);

  rmSync(output, { recursive: true, force: true });
  const files = {};
  for (const [key, source] of sources.sort(([a], [b]) => (a < b ? -1 : 1))) {
    const destination = join(output, ...key.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    files[key] = createHash("sha256")
      .update(readFileSync(destination))
      .digest("hex");
  }
  writeFileSync(
    join(output, "manifest.json"),
    `${JSON.stringify({ version, files }, null, 2)}\n`,
  );
  return { files: Object.keys(files).length };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const root = resolve(import.meta.dirname, "..");
  // Never trust an existing or cached UI build: it may carry a dev API URL.
  run("pnpm", ["--filter", "@tila/ui", "build"], {
    cwd: root,
    env: { ...process.env, VITE_API_URL: "" },
  });
  const workerDir = join(root, "packages/cli/worker");
  if (!existsSync(workerDir))
    throw new Error(
      "Run `pnpm --filter tila-cli run build:worker-sidecar` first",
    );
  const { files } = assemblePayload({
    workerDir,
    uiDir: join(root, "packages/ui/dist"),
    migrationsDir: join(root, "packages/worker/migrations/global"),
    output: join(root, "packages/cli/deploy-payload"),
    version: JSON.parse(
      readFileSync(join(root, "packages/cli/package.json"), "utf8"),
    ).version,
  });
  console.log(`Deploy payload: ${files} files in packages/cli/deploy-payload`);
}
