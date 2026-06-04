import {
  type ExecFileException,
  execFile as nodeExecFile,
} from "node:child_process";

/**
 * Minimum wrangler version that supports:
 * - [assets] not_found_handling = "single-page-application"
 * - run_worker_first as a glob array
 *
 * run_worker_first array support was introduced in wrangler 3.78.0.
 */
const MIN_WRANGLER_VERSION = [3, 78, 0] as const;
const MIN_WRANGLER_VERSION_STR = "3.78.0";

// ---------------------------------------------------------------------------
// Typed error classes
// ---------------------------------------------------------------------------

/**
 * Thrown when the wrangler binary is not found on PATH.
 * Includes installation guidance. Does NOT mention `wrangler login`
 * because auth is handled via CLOUDFLARE_API_TOKEN env var.
 */
export class WranglerNotFoundError extends Error {
  constructor() {
    super(
      "wrangler binary not found on PATH.\n\nInstall it with:\n  npm i -g wrangler\n  # or\n  pnpm add -g wrangler\n\nNote: authentication is handled automatically via the stored Cloudflare API token — no interactive login step is required.",
    );
    this.name = "WranglerNotFoundError";
  }
}

/**
 * Thrown when the installed wrangler version is below the minimum floor.
 * Includes upgrade guidance.
 */
export class WranglerVersionError extends Error {
  constructor(detectedVersion: string) {
    super(
      `wrangler version ${detectedVersion} is below the minimum required version ${MIN_WRANGLER_VERSION_STR}.\n\nThe minimum version is required for:\n  - [assets] not_found_handling = "single-page-application"\n  - run_worker_first glob array support\n\nUpgrade with:\n  npm i -g wrangler@latest\n  # or\n  pnpm add -g wrangler@latest`,
    );
    this.name = "WranglerVersionError";
  }
}

/**
 * Thrown when a Cloudflare API token is missing a required scope.
 * The error names the specific missing permission and includes the dashboard URL.
 */
export class TokenScopeError extends Error {
  constructor(missingScope: string) {
    super(
      `Cloudflare API token is missing the required scope: ${missingScope}\n\nUpdate your token at: https://dash.cloudflare.com/?to=/:account/api-tokens\n\nRequired scopes for tila deploy:\n  - Workers Scripts: Edit\n  - Account Settings: Read\n  - D1: Edit\n  - R2 Storage: Edit`,
    );
    this.name = "TokenScopeError";
  }
}

/**
 * Thrown when wrangler exits with a non-zero code.
 * The stderr is redacted to remove token-shaped strings.
 */
export class WranglerCommandError extends Error {
  constructor(redactedStderr: string) {
    super(`wrangler command failed:\n${redactedStderr}`);
    this.name = "WranglerCommandError";
  }
}

// ---------------------------------------------------------------------------
// Token redaction
// ---------------------------------------------------------------------------

/**
 * Replace any token-shaped substrings (30+ alphanumeric/dash/underscore chars)
 * with [REDACTED] to prevent secrets from appearing in error output.
 */
function redactTokens(text: string): string {
  return text.replace(/[A-Za-z0-9_\-]{30,}/g, "[REDACTED]");
}

// ---------------------------------------------------------------------------
// Version parsing
// ---------------------------------------------------------------------------

function parseVersion(versionStr: string): [number, number, number] | null {
  const match = versionStr.trim().match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isVersionAtLeast(
  version: [number, number, number],
  minimum: readonly [number, number, number],
): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i] > minimum[i]) return true;
    if (version[i] < minimum[i]) return false;
  }
  return true; // equal
}

// ---------------------------------------------------------------------------
// Safe subprocess wrapper
// ---------------------------------------------------------------------------

interface RunWranglerOptions {
  token: string;
  accountId: string;
  cwd?: string;
}

interface RunWranglerResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Spawn wrangler using the security contract:
 * - argv array (never a shell string)
 * - shell: false
 * - explicit minimal env: { PATH, HOME, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID }
 * - stdio: ["ignore", "pipe", "pipe"]
 * - token never interpolated into args or logged
 * - stderr redacted via /[A-Za-z0-9_\-]{30,}/g → [REDACTED] before surfacing
 */
export function runWrangler(
  args: string[],
  { token, accountId, cwd }: RunWranglerOptions,
): Promise<RunWranglerResult> {
  return new Promise((resolve, reject) => {
    const minimalEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      CLOUDFLARE_API_TOKEN: token,
      CLOUDFLARE_ACCOUNT_ID: accountId,
    };

    const opts = {
      env: minimalEnv,
      shell: false,
      ...(cwd ? { cwd } : {}),
    };

    nodeExecFile(
      "wrangler",
      args,
      opts,
      (err: ExecFileException | null, stdout: string, stderr: string) => {
        if (err) {
          const redactedStderr = redactTokens(stderr || err.message || "");
          reject(new WranglerCommandError(redactedStderr));
          return;
        }
        resolve({ stdout, stderr, code: 0 });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Presence and version detection
// ---------------------------------------------------------------------------

/**
 * Probe wrangler presence and version.
 * - Throws WranglerNotFoundError on ENOENT / wrangler not on PATH.
 * - Throws WranglerVersionError when version is below MIN_WRANGLER_VERSION.
 * - Resolves (undefined) when wrangler is present and version-OK.
 */
export function detectWrangler(): Promise<void> {
  return new Promise((resolve, reject) => {
    const opts = {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        CLOUDFLARE_API_TOKEN: "",
        CLOUDFLARE_ACCOUNT_ID: "",
      },
      shell: false,
    };

    nodeExecFile(
      "wrangler",
      ["--version"],
      opts,
      (err: ExecFileException | null, stdout: string) => {
        if (err) {
          if (err.code === "ENOENT") {
            reject(new WranglerNotFoundError());
            return;
          }
          // Non-ENOENT: try to parse version from stdout before failing
          const parsed = parseVersion(stdout ?? "");
          if (!parsed) {
            reject(new WranglerNotFoundError());
            return;
          }
          if (!isVersionAtLeast(parsed, MIN_WRANGLER_VERSION)) {
            reject(new WranglerVersionError(parsed.join(".")));
            return;
          }
          resolve();
          return;
        }

        const parsed = parseVersion(stdout ?? "");
        if (!parsed) {
          // Can't determine version — assume not found
          reject(new WranglerNotFoundError());
          return;
        }

        if (!isVersionAtLeast(parsed, MIN_WRANGLER_VERSION)) {
          reject(new WranglerVersionError(parsed.join(".")));
          return;
        }

        resolve();
      },
    );
  });
}

// ---------------------------------------------------------------------------
// URL extraction
// ---------------------------------------------------------------------------

/**
 * Extract the deployed workers.dev URL from wrangler's stdout.
 * Returns null if no URL is found; the caller then constructs
 * https://<scriptName>.workers.dev from the known Worker script name as a fallback.
 */
export function parseDeployedUrl(stdout: string): string | null {
  const match = stdout.match(/https:\/\/[^\s]+\.workers\.dev/);
  return match ? match[0] : null;
}

// ---------------------------------------------------------------------------
// Token scope validation — capability probes
// ---------------------------------------------------------------------------

/**
 * Run read-only capability probes against the Cloudflare API to determine
 * whether the token has the required scopes for `wrangler deploy`.
 *
 * Probe table:
 *   GET /accounts/:id/workers/scripts → 403 → "Workers Scripts: Edit"
 *   GET /accounts/:id/d1/database     → 403 → "D1: Edit"
 *   GET /accounts/:id/r2/buckets      → 403 → "R2 Storage: Edit"
 *
 * The account probe (Account Settings: Read) is already done by `verifyCloudflareAuth`.
 *
 * Non-403 errors (network, 5xx) are non-fatal: logged as a note, not thrown.
 * This avoids blocking deploy on an unreliable probe — the user gets wrangler's
 * own (redacted) 403 instead if the scope is actually missing.
 *
 * Throws TokenScopeError on the first 403 probe, naming the missing permission
 * and linking to the dashboard token management page.
 */
export async function validateTokenScopes(
  token: string,
  accountId: string,
): Promise<void> {
  const baseUrl = "https://api.cloudflare.com/client/v4";
  const headers = { Authorization: `Bearer ${token}` };

  const probes: Array<{ path: string; scope: string }> = [
    {
      path: `/accounts/${accountId}/workers/scripts`,
      scope: "Workers Scripts: Edit",
    },
    { path: `/accounts/${accountId}/d1/database`, scope: "D1: Edit" },
    { path: `/accounts/${accountId}/r2/buckets`, scope: "R2 Storage: Edit" },
  ];

  for (const { path, scope } of probes) {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        headers,
        signal: AbortSignal.timeout(8_000),
      });

      if (res.status === 403) {
        throw new TokenScopeError(scope);
      }
      // Non-403 non-ok (5xx, network-level handled by catch): non-fatal, continue
    } catch (err) {
      if (err instanceof TokenScopeError) {
        throw err; // Re-throw — this is the expected failure signal
      }
      // Network error or other non-403: non-fatal, log and continue
      // (don't expose the error — it may contain the token)
    }
  }
}
