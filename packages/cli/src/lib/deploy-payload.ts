import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * Release binaries embed the Worker bundle, UI build and D1 migrations with
 * `bun build --compile --asset deploy-payload` (scripts/build-deploy-payload.mjs).
 * Wrangler and the D1 migration runner need real files, so the payload is
 * staged into a versioned cache directory before deploy:
 *
 *   <cache>/<version>-<manifest digest>/
 *   ├── manifest.json
 *   ├── worker/index.js
 *   ├── ui/dist/**
 *   └── migrations/global/*.sql
 */
export const PAYLOAD_DIR = "deploy-payload";
const MANIFEST = "manifest.json";
const SHA256 = /^[0-9a-f]{64}$/;

export interface PayloadManifest {
  version: string;
  files: Record<string, string>;
}

export interface StagedPayload {
  root: string;
  version: string;
  workerMain: string;
  uiDist: string;
  migrationsDir: string;
}

export class DeployPayloadError extends Error {
  constructor(reason: string) {
    super(
      `This tila binary has no usable deploy payload: ${reason}\n\nReinstall tila-cli or run \`tila update\`.`,
    );
    this.name = "DeployPayloadError";
  }
}

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Root of the embedded payload inside a compiled binary, or null when tila
 * runs from source (Bun or Node), where the monorepo paths are used instead.
 */
export function embeddedPayloadRoot(): string | null {
  const bun = (globalThis as { Bun?: { isStandaloneExecutable?: boolean } })
    .Bun;
  if (!bun?.isStandaloneExecutable) return null;
  const dir = (import.meta as { dir?: string }).dir;
  if (!dir) return null;
  return join(dir, PAYLOAD_DIR);
}

export function parseManifest(bytes: Uint8Array): PayloadManifest {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new DeployPayloadError("manifest.json is not valid JSON.");
  }
  const manifest = value as Partial<PayloadManifest> | null;
  if (
    !manifest ||
    typeof manifest.version !== "string" ||
    !manifest.files ||
    typeof manifest.files !== "object"
  )
    throw new DeployPayloadError("manifest.json has an invalid shape.");
  const entries = Object.entries(manifest.files);
  if (entries.length === 0)
    throw new DeployPayloadError("manifest.json lists no files.");
  for (const [path, digest] of entries) {
    const parts = path.split("/");
    if (
      path === MANIFEST ||
      path.startsWith("/") ||
      path.includes("\\") ||
      parts.some((part) => part === "" || part === "." || part === "..")
    )
      throw new DeployPayloadError(
        `manifest.json lists an unsafe path: ${path}`,
      );
    if (typeof digest !== "string" || !SHA256.test(digest))
      throw new DeployPayloadError(
        `manifest.json has an invalid digest for ${path}`,
      );
  }
  return { version: manifest.version, files: manifest.files };
}

// Manifest keys are POSIX; map them onto the native path separator.
const nativePath = (root: string, key: string) => join(root, ...key.split("/"));

function payloadMatches(root: string, manifest: PayloadManifest): boolean {
  for (const [key, digest] of Object.entries(manifest.files)) {
    const file = nativePath(root, key);
    if (!existsSync(file) || sha256(readFileSync(file)) !== digest)
      return false;
  }
  return true;
}

function describe(root: string, version: string): StagedPayload {
  return {
    root,
    version,
    workerMain: join(root, "worker", "index.js"),
    uiDist: join(root, "ui", "dist"),
    migrationsDir: join(root, "migrations", "global"),
  };
}

function pruneOtherVersions(cacheRoot: string, keep: string): void {
  try {
    for (const entry of readdirSync(cacheRoot)) {
      if (entry === keep || entry.startsWith(".")) continue;
      rmSync(join(cacheRoot, entry), { recursive: true, force: true });
    }
  } catch {
    // Best effort: an old payload left behind only costs disk space.
  }
}

/**
 * Verify the payload at `sourceRoot` and copy it into `cacheRoot`.
 *
 * Reuses an existing staged copy when every listed file still matches its
 * digest. Files that are not in the manifest are ignored, because wrangler
 * writes its generated config and `.wrangler/` state into the staged worker
 * directory. Concurrent processes stage into private directories and rename
 * into place; the loser of that race uses the winner's verified copy.
 */
export function stagePayload(options: {
  sourceRoot: string;
  cacheRoot: string;
  version: string;
}): StagedPayload {
  const { sourceRoot, cacheRoot, version } = options;
  const manifestPath = join(sourceRoot, MANIFEST);
  if (!existsSync(manifestPath))
    throw new DeployPayloadError("manifest.json is missing.");
  const manifestBytes = readFileSync(manifestPath);
  const manifest = parseManifest(manifestBytes);
  if (manifest.version !== version)
    throw new DeployPayloadError(
      `payload version ${manifest.version} does not match CLI version ${version}.`,
    );

  const name = `${version}-${sha256(manifestBytes).slice(0, 16)}`;
  const target = join(cacheRoot, name);
  if (existsSync(target)) {
    if (payloadMatches(target, manifest)) {
      pruneOtherVersions(cacheRoot, name);
      return describe(target, version);
    }
    // A damaged or edited cache is rebuilt from the embedded copy.
    rmSync(target, { recursive: true, force: true });
  }

  mkdirSync(cacheRoot, { recursive: true });
  const staging = mkdtempSync(join(cacheRoot, ".staging-"));
  try {
    for (const [key, digest] of Object.entries(manifest.files)) {
      const source = nativePath(sourceRoot, key);
      if (!existsSync(source))
        throw new DeployPayloadError(`${key} is missing.`);
      const bytes = readFileSync(source);
      if (sha256(bytes) !== digest)
        throw new DeployPayloadError(`${key} does not match its digest.`);
      const destination = nativePath(staging, key);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes);
    }
    writeFileSync(join(staging, MANIFEST), manifestBytes);
    try {
      renameSync(staging, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        !["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(code ?? "") ||
        !payloadMatches(target, manifest)
      )
        throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  pruneOtherVersions(cacheRoot, name);
  return describe(target, version);
}

let staged: StagedPayload | null | undefined;

/**
 * Stage the embedded payload once per process. Returns null outside a
 * compiled binary. Throws DeployPayloadError when a compiled binary has no
 * valid payload, so callers never fall back to monorepo paths that do not
 * exist inside the binary.
 */
export function stageEmbeddedPayload(
  cacheRoot: string,
  version: string,
): StagedPayload | null {
  if (staged !== undefined) return staged;
  const sourceRoot = embeddedPayloadRoot();
  staged =
    sourceRoot === null
      ? null
      : stagePayload({ sourceRoot, cacheRoot, version });
  return staged;
}

/** Test-only: forget the memoized staging result. */
export function resetStagedPayloadForTests(): void {
  staged = undefined;
}
