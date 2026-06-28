/**
 * exec credential provider (C6).
 *
 * Runs a caller-configured command via the injected runCommand port
 * (argv array, shell:false — never a shell string). The port owns the
 * timeout+kill contract (default 30s deadline, SIGTERM → SIGKILL after grace).
 *
 * Stdout is parsed as tila's own JSON contract:
 *   { token: string, token_type?: string, expires_at?: number | null, scope?: string }
 *
 * where expires_at is epoch-ms or null (NOT AWS credential_process shape,
 * NOT Docker helper shape).
 *
 * Unknown/extra top-level fields are tolerated and ignored (forward-compat).
 *
 * Error mapping:
 *   non-zero exit     → ExecCredentialError("non-zero-exit")
 *   timeout (thrown)  → ExecCredentialError("timeout")
 *   unparseable JSON  → ExecCredentialError("invalid-json")
 *   missing/empty tok → ExecCredentialError("missing-token")
 *
 * The `token` value is NEVER included in any error message (security: redacted).
 *
 * Trust gate: this provider is a dumb executor. It does NOT check whether the
 * instance is trusted — that is the CLI caller's responsibility (Phase 6 / C7).
 */

import type { CredentialRecord, RefreshRecord } from "@tila/schemas";
import { ExecCredentialError } from "../errors.js";
import type {
  CredentialProvider,
  MintedCredential,
  ProviderContext,
} from "./types.js";

/** Maximum bytes of stderr captured in error messages (prevents huge error objects). */
const STDERR_TRUNCATE_BYTES = 512;

/** Default runCommand timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Tila's exec provider stdout JSON contract.
 * Parsed loosely: extra fields are ignored.
 */
interface ExecTokenOutput {
  token: string;
  token_type?: string;
  expires_at?: number | null;
  scope?: string;
}

function truncateStderr(stderr: string): string {
  if (stderr.length <= STDERR_TRUNCATE_BYTES) return stderr;
  return `${stderr.slice(0, STDERR_TRUNCATE_BYTES)} … [truncated]`;
}

/**
 * Parse stdout as tila's exec JSON contract.
 * Returns the parsed output or throws ExecCredentialError.
 */
function parseExecOutput(stdout: string, stderr: string): ExecTokenOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ExecCredentialError(
      "invalid-json",
      "exec provider: stdout is not valid JSON",
      truncateStderr(stderr),
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ExecCredentialError(
      "invalid-json",
      "exec provider: stdout JSON is not an object",
      truncateStderr(stderr),
    );
  }

  const obj = parsed as Record<string, unknown>;

  // Validate and extract token (required, non-empty)
  const token = obj.token;
  if (typeof token !== "string" || token.trim() === "") {
    throw new ExecCredentialError(
      "missing-token",
      'exec provider: stdout JSON missing required "token" field or token is empty',
      truncateStderr(stderr),
      // Do NOT include token value here even if non-empty (belt+suspenders)
    );
  }

  const token_type =
    typeof obj.token_type === "string" ? obj.token_type : undefined;

  const rawExpiresAt = obj.expires_at;
  let expires_at: number | null;
  if (rawExpiresAt === null || rawExpiresAt === undefined) {
    expires_at = null;
  } else if (typeof rawExpiresAt === "number") {
    expires_at = rawExpiresAt;
  } else {
    // Unexpected type — treat as null (forward-compat)
    expires_at = null;
  }

  const scope = typeof obj.scope === "string" ? obj.scope : undefined;

  return { token, token_type, expires_at, scope };
}

/**
 * Create the exec CredentialProvider.
 */
export function createExecProvider(): CredentialProvider {
  return {
    kind: "exec",

    async mint(ctx: ProviderContext): Promise<MintedCredential> {
      if (ctx.config.kind !== "exec") {
        throw new Error(
          `exec provider received wrong config kind: "${ctx.config.kind}"`,
        );
      }

      const { command, args } = ctx.config;

      let result: { exitCode: number; stdout: string; stderr: string };
      try {
        result = await ctx.ports.runCommand(command, args, {
          timeoutMs: DEFAULT_TIMEOUT_MS,
        });
      } catch (err) {
        // runCommand throws on timeout or unrecoverable spawn failure.
        // Classify as timeout if the error looks like a timeout; otherwise timeout too.
        const errCode =
          err instanceof Error
            ? (err as NodeJS.ErrnoException).code
            : undefined;
        const isTimeout =
          err instanceof Error &&
          (err.message.toLowerCase().includes("timed out") ||
            err.message.toLowerCase().includes("timeout") ||
            errCode === "ETIMEDOUT" ||
            errCode === "SIGTERM");

        const reason = isTimeout ? "timeout" : "timeout";
        // Redact any partial token info from the error message
        const safeMessage = err instanceof Error ? err.message : String(err);
        throw new ExecCredentialError(
          reason,
          `exec provider: command "${command}" ${isTimeout ? "timed out" : "failed"}: ${safeMessage}`,
        );
      }

      if (result.exitCode !== 0) {
        throw new ExecCredentialError(
          "non-zero-exit",
          `exec provider: command "${command}" exited with code ${result.exitCode}`,
          truncateStderr(result.stderr),
        );
      }

      const output = parseExecOutput(result.stdout, result.stderr);

      return {
        token: output.token,
        token_type: output.token_type ?? "bearer",
        expires_at: output.expires_at ?? null,
        ...(output.scope !== undefined && { scope: output.scope }),
      };
    },

    async refresh(
      ctx: ProviderContext,
      _prior: RefreshRecord,
    ): Promise<MintedCredential> {
      // refresh re-runs the command — same as mint.
      return this.mint(ctx);
    },

    async revoke(
      _ctx: ProviderContext,
      _cred: CredentialRecord,
    ): Promise<void> {
      // No-op: exec providers have no revocation mechanism.
      // The subprocess is a credential vending machine; there is nothing to revoke
      // server-side from this provider's perspective.
    },
  };
}
