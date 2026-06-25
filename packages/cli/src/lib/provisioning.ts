import { execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import * as dotenv from "dotenv";

/**
 * Resolve the tila home directory.
 *
 * Resolution order:
 * 1. TILA_HOME env var (allows CI/automation to override the default location)
 * 2. ~/.tila (OS home directory fallback)
 *
 * Returns an absolute path. Never throws.
 */
export function tilaHome(): string {
  const envHome = process.env.TILA_HOME;
  if (envHome) return envHome;
  return join(os.homedir(), ".tila");
}

/**
 * Derive the org/owner name from the git remote URL.
 *
 * Parses the owner segment from GitHub/GitLab/Bitbucket remote URLs
 * (HTTPS and SSH formats). Falls back to the OS username if the
 * directory is not a git repo or the remote URL format is unrecognized.
 *
 * Never throws -- all errors are caught and silently fall back.
 */
export function deriveOrg(cwd: string): string {
  try {
    const remoteUrl = execSync(
      `git -C ${JSON.stringify(cwd)} remote get-url origin`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    const match = remoteUrl.match(/(?:https?:\/\/[^/]+\/|git@[^:]+:)([^/]+)\//);
    if (match?.[1]) return match[1].toLowerCase();
  } catch {
    /* ignore -- not a git repo or no remote */
  }
  try {
    return os.userInfo().username;
  } catch {
    return "local";
  }
}

/**
 * Resolve the Worker entry-point path for wrangler.toml `main` field.
 *
 * Resolution order:
 * 1. TILA_WORKER_DIST env var (absolute path override)
 * 2. process.execPath-relative sidecar (installed binary scenario)
 * 3. import.meta.url-relative monorepo fallback (dev scenario)
 *
 * All strategies return an absolute path. Never throws.
 */
export function resolveWorkerMainPath(): string {
  // Strategy 1: env var override
  const envOverride = process.env.TILA_WORKER_DIST;
  if (envOverride) {
    return envOverride;
  }

  // Strategy 2: sidecar next to the compiled binary
  const sidecarPath = join(dirname(process.execPath), "worker", "index.js");
  if (existsSync(sidecarPath)) {
    return sidecarPath;
  }

  // Strategy 3: monorepo fallback (relative to this source file)
  return fileURLToPath(
    new URL("../../../../packages/worker/src/index.ts", import.meta.url),
  );
}

/**
 * Resolve CLOUDFLARE_API_TOKEN from environment or .tila/.env files.
 *
 * Resolution order:
 * 1. CLOUDFLARE_API_TOKEN env var
 * 2. ~/.tila/.env (home directory)
 * 3. .tila/.env (project directory)
 *
 * Returns null if not found in any location.
 */
export function resolveCfApiToken(): string | null {
  if (process.env.CLOUDFLARE_API_TOKEN) {
    return process.env.CLOUDFLARE_API_TOKEN;
  }

  const homeEnv = join(tilaHome(), ".env");
  if (existsSync(homeEnv)) {
    const parsed = dotenv.parse(readFileSync(homeEnv));
    if (parsed.CLOUDFLARE_API_TOKEN) return parsed.CLOUDFLARE_API_TOKEN;
  }

  const projectEnv = join(".tila", ".env");
  if (existsSync(projectEnv)) {
    const parsed = dotenv.parse(readFileSync(projectEnv));
    if (parsed.CLOUDFLARE_API_TOKEN) return parsed.CLOUDFLARE_API_TOKEN;
  }

  return null;
}

/**
 * Resolve the D1 migrations directory path using the same strategy cascade
 * as resolveWorkerMainPath. Returns an absolute path.
 */
export function resolveMigrationsDir(): string {
  // Strategy 1: sidecar next to the compiled binary
  const sidecarPath = join(dirname(process.execPath), "migrations", "global");
  if (existsSync(sidecarPath)) {
    return sidecarPath;
  }

  // Strategy 2: monorepo fallback
  return fileURLToPath(
    new URL("../../../../packages/worker/migrations/global", import.meta.url),
  );
}

export function resolveUiDistDir(): string {
  const envOverride = process.env.TILA_UI_DIST;
  if (envOverride) {
    return envOverride;
  }

  const sidecarPath = join(dirname(process.execPath), "ui", "dist");
  if (existsSync(sidecarPath)) {
    return sidecarPath;
  }

  return fileURLToPath(
    new URL("../../../../packages/ui/dist", import.meta.url),
  );
}

/**
 * Returns true when tila is running from the monorepo source tree (dev layout),
 * false when running from an installed binary (sidecar layout) or env override.
 *
 * Strategy detection mirrors `resolveWorkerMainPath` / `resolveUiDistDir`:
 * 1. If TILA_WORKER_DIST or TILA_UI_DIST env var is set → env override (not monorepo)
 * 2. If the sidecar worker path exists next to process.execPath → sidecar (not monorepo)
 * 3. Otherwise → monorepo fallback (dev layout)
 *
 * Consumed by:
 * - wrangler-config.ts: to compute relative paths (both layouts yield `../ui/dist`)
 * - deploy.ts: to gate `pnpm --filter @tila/ui build` to monorepo-only
 */
export function isMonorepoLayout(): boolean {
  // Strategy 1: env override
  if (process.env.TILA_WORKER_DIST || process.env.TILA_UI_DIST) {
    return false;
  }

  // Strategy 2: sidecar binary
  const sidecarPath = join(dirname(process.execPath), "worker", "index.js");
  if (existsSync(sidecarPath)) {
    return false;
  }

  // Strategy 3: monorepo fallback
  return true;
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX_LENGTH = 48;

export function validateSlug(value: string): string | undefined {
  if (value.length === 0) return "Name cannot be empty";
  if (value.length > SLUG_MAX_LENGTH)
    return `Name must be ${SLUG_MAX_LENGTH} characters or fewer`;
  if (!SLUG_PATTERN.test(value))
    return "Lowercase letters, numbers, and hyphens only (no leading/trailing hyphens)";
  return undefined;
}

export async function resolveProjectName(
  cwd: string,
  nameFlag?: string,
): Promise<string> {
  if (nameFlag) {
    const err = validateSlug(nameFlag);
    if (err) {
      p.cancel(`Invalid project name "${nameFlag}": ${err}`);
      process.exit(1);
    }
    return nameFlag;
  }

  if (!process.stdin.isTTY) {
    return generateSlug(cwd);
  }

  const defaultName = generateSlug(cwd);
  const result = await p.text({
    message: "Project name",
    defaultValue: defaultName,
    placeholder: defaultName,
    validate: (v) => validateSlug(v ?? ""),
  });
  if (p.isCancel(result)) {
    p.cancel("Operation cancelled.");
    process.exit(1);
  }
  return result;
}

export function generateSlug(cwd: string): string {
  const dirSlug = basename(cwd)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const randomSuffix = randomBytes(3).toString("hex");
  return `${dirSlug}-${randomSuffix}`;
}

/**
 * Ensure entries are present in .gitignore.
 * Creates the file if it doesn't exist. Hard-fails on write error (security gate).
 */
export function ensureGitignored(
  entries: string[],
  cwd: string = process.cwd(),
): void {
  const gitignorePath = join(cwd, ".gitignore");
  let existing = "";
  try {
    existing = readFileSync(gitignorePath, "utf-8");
  } catch {
    // File doesn't exist yet -- will create it
  }
  const toAdd = entries.filter((e) => !existing.includes(e));
  if (toAdd.length > 0) {
    try {
      appendFileSync(gitignorePath, `\n# tila\n${toAdd.join("\n")}\n`);
    } catch (err) {
      console.error(`Failed to update .gitignore: ${err}`);
      console.error(
        "This is a hard error -- .tila/.env must be in .gitignore to prevent accidental token commit.",
      );
      process.exit(1);
    }
  }
}

/**
 * Hash a raw token using SHA-256 (matching the Worker auth middleware).
 * Returns lowercase hex string.
 *
 * NOTE: this is bare SHA-256, while the Worker hashes with HASH_PEPPER when set.
 * Under a set pepper a CLI-minted bootstrap hash would mismatch the Worker lookup —
 * a pre-existing SEC-1 migration gap, out of scope for the token-format change
 * (see the T5 design Open Questions). The hash stays over the FULL token string,
 * so the new tila_d1_ format flows through it unchanged.
 */
export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/**
 * The prefix for D1 long-lived API tokens.
 * Format: tila_d1_<64-hex-entropy><8-hex-checksum> (80 chars total)
 *
 * Format spec single source of truth: packages/worker/src/lib/token-format.ts
 * (WebCrypto mirror) and the T5 design C1. Parity between the two runtimes is
 * pinned by the shared fixed-entropy fixture asserted in both test suites.
 */
export const D1_TOKEN_PREFIX = "tila_d1_";

/**
 * Generate a raw D1 API token with checksum.
 * Format: tila_d1_<64-hex-entropy><8-hex-checksum> (80 chars total)
 *
 * The checksum is the first 4 bytes (8 hex chars) of SHA-256(raw entropy bytes).
 * It is computed pre-pepper, over the raw bytes — not the hex string. Authenticity
 * is still determined solely by the peppered hash lookup in D1; the checksum is a
 * public, integrity-only typo/corruption pre-filter. Storage hash remains over the
 * full token string via hashToken().
 */
export function generateRawToken(): string {
  const entropy = randomBytes(32);
  const checksum = createHash("sha256")
    .update(entropy)
    .digest("hex")
    .slice(0, 8);
  return D1_TOKEN_PREFIX + entropy.toString("hex") + checksum;
}

/**
 * Verify the structural checksum of a D1 token.
 *
 * Returns:
 *   "ok"           — the token has a valid tila_d1_ prefix and the embedded
 *                    checksum matches the recomputed value
 *   "bad-checksum" — the token has a tila_d1_ prefix but fails the shape
 *                    guard or checksum comparison
 *   "not-d1-token" — the token does not have the tila_d1_ prefix (legacy
 *                    tokens, dev tokens, session tokens, etc.) — callers
 *                    should not reject these, just skip the checksum gate
 *
 * This function is synchronous (Node crypto), pepper-free, and total
 * (never throws). It is a pre-filter only — authenticity is still
 * determined by the peppered hash lookup in D1.
 */
export function verifyD1TokenChecksum(
  token: string,
): "ok" | "bad-checksum" | "not-d1-token" {
  if (!token.startsWith(D1_TOKEN_PREFIX)) {
    return "not-d1-token";
  }
  const body = token.slice(D1_TOKEN_PREFIX.length);
  // Body must be exactly 72 lowercase hex chars (64 entropy + 8 checksum)
  if (!/^[0-9a-f]{72}$/.test(body)) {
    return "bad-checksum";
  }
  const entropyHex = body.slice(0, 64);
  const embedded = body.slice(64); // 8 hex chars
  try {
    const entropyBytes = Buffer.from(entropyHex, "hex");
    const expected = createHash("sha256")
      .update(entropyBytes)
      .digest("hex")
      .slice(0, 8);
    return embedded === expected ? "ok" : "bad-checksum";
  } catch {
    return "bad-checksum";
  }
}

/**
 * Generate a 32-byte random HMAC signing key encoded as base64url.
 * Used as the GITHUB_SESSION_SECRET Wrangler secret for GitHub-scoped auth.
 */
export function generateHmacKey(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Derive the owner/repo from the git remote URL.
 *
 * Parses both HTTPS and SSH remote URL formats:
 * - https://github.com/owner/repo.git
 * - git@github.com:owner/repo.git
 *
 * Returns null if not in a git repo, no remote is set, or the URL
 * format is unrecognized. Never throws.
 */
export function deriveRepo(
  cwd: string,
): { owner: string; repo: string } | null {
  try {
    const remoteUrl = execSync(
      `git -C ${JSON.stringify(cwd)} remote get-url origin`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    const match = remoteUrl.match(
      /(?:https?:\/\/[^/]+\/|git@[^:]+:)([^/]+)\/([^/.]+)(?:\.git)?$/,
    );
    if (match?.[1] && match?.[2]) {
      return { owner: match[1], repo: match[2] };
    }
  } catch {
    /* not a git repo or no remote */
  }
  return null;
}

/**
 * Generate the default tila.schema.toml content for a new project.
 * Includes v0.1 searchable artifact kind defaults.
 *
 * SYNC OBLIGATION: If you change this template, also update the inline
 * fixture BUNDLED_DEFAULT_SCHEMA_TOML in packages/core/test/schema-parser.test.ts.
 */
export function generateDefaultSchemaToml(): string {
  return `schema_version = 1

# ---------------------------------------------------------------------------
# WORK UNITS — types of work items tracked in this project
# ---------------------------------------------------------------------------

[work_units.task]
fields = [
  { name = "title",       required = true,  type = "string" },
  { name = "description", required = false, type = "text" },
  { name = "status",      required = true,  type = "enum",
    values = ["open", "in_progress", "blocked", "done", "cancelled"] },
]
parents = []

# ---------------------------------------------------------------------------
# ARTIFACTS — content-addressed blobs produced or uploaded into the project
# ---------------------------------------------------------------------------

[artifacts.lesson]
mime_types = ["text/markdown"]
retention_days = 0            # never expire — project memory
searchable = true             # opt-in to FTS5 full-text indexing
search_mode = "full_text"

[artifacts.adr]
mime_types = ["text/markdown"]
retention_days = 0            # never expire — architectural decisions
searchable = true
search_mode = "full_text"

[artifacts.plan]
mime_types = ["text/markdown"]
retention_days = 30
searchable = true
search_mode = "full_text"

[artifacts.design]
mime_types = ["text/markdown"]
retention_days = 90
searchable = true
search_mode = "full_text"

[artifacts.review]
mime_types = ["text/markdown"]
retention_days = 30
requires_reference_to = ["design"]
searchable = true
search_mode = "full_text"

[artifacts.research]
mime_types = ["text/markdown", "text/plain", "application/pdf"]
retention_days = 0            # never expire — source artifacts
searchable = true
search_mode = "full_text"

[artifacts.index]
mime_types = ["text/markdown"]
retention_days = 0
searchable = true             # index artifacts gather entries under a scope
search_mode = "full_text"

[artifacts.patch]
mime_types = ["text/x-patch", "application/x-patch"]
retention_days = 7
searchable = false            # binary-adjacent; not useful to index as text

# ---------------------------------------------------------------------------
# ARTIFACT RELATIONSHIPS — typed edges artifacts can have to each other
# ---------------------------------------------------------------------------

[artifact_relationships]
types = [
  "references",
  "supersedes",
  "derived-from",
  "extends",
  "rebuts",
  "index-of",
  "entry-of",
]
`;
}
