/**
 * Shared output utilities for CLI commands.
 *
 * RULE: This file is the exclusive home for all formatting libraries.
 * No command file may import ansis, console-table-printer, yocto-spinner,
 * or object-treeify directly.
 */
import ansis from "ansis";
import { Table } from "console-table-printer";
import treeify from "object-treeify";
import createSpinner from "yocto-spinner";
import { EXIT_CODES, exitCodeFor } from "./exit-codes";

// --- CLI JSON envelope types (NOT coupled to the HTTP ErrorEnvelope) ---

/**
 * Standard success envelope for all CLI --json output.
 * Consumer automation should key on `ok: true` to detect success.
 */
export type CliSuccessEnvelope<T> = { ok: true; result: T };

/**
 * Standard error envelope for all CLI --json output.
 * `code` is a stable machine-readable error code (from TILA_ERRORS or CLI-local).
 * `hint` is optional remediation advice.
 */
export type CliErrorEnvelope = {
  ok: false;
  code: string;
  message: string;
  hint?: string;
};

/**
 * Shared --json argument declaration. Spread this into every leaf subcommand's
 * `args` instead of declaring `json: { type: "boolean", ... }` per command.
 *
 * Citty 0.2.2 has NO arg inheritance — a root-declared flag never reaches
 * subcommand `run` contexts. The shared spread ensures every command opts in.
 */
export const jsonArg = {
  json: {
    type: "boolean" as const,
    description: "Output as structured JSON",
    default: false,
  },
} as const;

// --- Existing utilities (unchanged) ---

/**
 * Serialize data as JSON to stdout with 2-space indentation.
 * Use for successful command output in --json mode.
 */
export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Serialize a successful result as a {@link CliSuccessEnvelope} JSON to stdout.
 * Prefer this over raw `printJson({ ok: true, ... })` so the envelope shape
 * is consistent across all commands.
 */
export function printJsonSuccess<T>(result: T): void {
  printJson({ ok: true, result } satisfies CliSuccessEnvelope<T>);
}

/**
 * Serialize an error as a {@link CliErrorEnvelope} JSON to stderr and exit.
 *
 * The caller is responsible for passing the correct exit code (typically
 * computed via `exitCodeFor` from `error-boundary`). This function does NOT
 * import from `error-boundary` to avoid a circular dependency.
 *
 * @param error - Human-readable error message
 * @param code - Machine-readable error code (e.g. "not-found", "do-unreachable")
 * @param hint - Optional remediation hint shown to the user
 * @param exitCode - Process exit code (default: 1 / USER_ERROR)
 */
export function printJsonError(
  error: string,
  code: string,
  hint?: string,
  exitCode = 1,
): never {
  const envelope: CliErrorEnvelope = {
    ok: false,
    code,
    message: error,
    ...(hint !== undefined ? { hint } : {}),
  };
  console.error(JSON.stringify(envelope, null, 2));
  process.exit(exitCode);
}

/**
 * Convert Unix epoch milliseconds to ISO 8601 string.
 * Token timestamps use epoch seconds -- multiply by 1000 before calling this.
 */
export function tsToIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/**
 * Collapse a backend/coordination error into a stable `{ code, message }` pair
 * suitable for a single-line CLI error.
 *
 * Fence rejections reach the CLI as either a local `FenceError` (name
 * "FenceError", carries `currentFence`/`claimedFence`) or a remote
 * `TilaApiError` with code "stale-fence". Both are normalized to the
 * "stale-fence" code with one actionable sentence. Any other error is reduced
 * to its first line so the bundled stack trace never reaches the user.
 *
 * Structural duck-typing (not `instanceof`) keeps this helper free of a
 * dependency on `tila-sdk` / `@tila/core`.
 */
export function describeCliError(err: unknown): {
  code: string;
  message: string;
  hint?: string;
} {
  const e = err as {
    name?: string;
    code?: string;
    message?: string;
    currentFence?: number;
    claimedFence?: number;
  };
  const isStaleFence =
    e?.name === "FenceError" ||
    (e?.name === "TilaApiError" && e?.code === "stale-fence");
  if (isStaleFence) {
    const detail =
      typeof e.currentFence === "number" && typeof e.claimedFence === "number"
        ? ` (current=${e.currentFence}, presented=${e.claimedFence})`
        : "";
    return {
      code: "stale-fence",
      message: `Stale fence: the claim was superseded${detail}. Re-acquire the claim and retry.`,
    };
  }
  const code = typeof e?.code === "string" && e.code ? e.code : "ERROR";
  const raw =
    typeof e?.message === "string" && e.message ? e.message : String(err);
  const hint = _remediationHint(code);
  return {
    code,
    message: raw.split("\n")[0].trim(),
    ...(hint ? { hint } : {}),
  };
}

/**
 * Return a remediation hint for network/backend error classes.
 * Returns undefined for user-error codes (no hint needed).
 */
function _remediationHint(code: string): string | undefined {
  if (exitCodeFor(code) === EXIT_CODES.NETWORK_ERROR) {
    switch (code) {
      case "RATE_LIMITED":
        return "The server is rate-limiting requests. Wait a moment and retry.";
      case "do-unreachable":
        return "The project backend is unreachable. Check your network connection and retry.";
      default:
        return "A transient server error occurred. Retry the command.";
    }
  }
  return undefined;
}

/**
 * Render a backend/coordination error as a clean one-line message and exit.
 *
 * Without this, an uncaught `TilaApiError`/`FenceError` bubbles to citty's
 * top-level handler, which dumps the full error object and bundled stack trace.
 * In `--json` mode the error is emitted as a structured {@link CliErrorEnvelope}
 * via {@link printJsonError}; otherwise a single line is written to stderr.
 *
 * The exit code is determined by `exitCodeFor(code)` — network-class errors
 * exit 2 (NETWORK_ERROR) so automation can retry; all others exit 1 (USER_ERROR).
 */
export function failWithCliError(err: unknown, json: boolean): never {
  const { code, message, hint } = describeCliError(err);
  const exit = exitCodeFor(code);
  if (json) {
    printJsonError(message, code, hint, exit);
  } else {
    console.error(message);
    process.exit(exit);
  }
}

// --- New formatter utilities ---

/**
 * Render a table to stdout using console-table-printer.
 * No-op when rows is empty (caller handles empty state message).
 */
export function renderTable(
  rows: Record<string, unknown>[],
  columns: { key: string; label: string; color?: string }[],
  opts?: { title?: string },
): void {
  if (rows.length === 0) return;
  const table = new Table({
    title: opts?.title,
    columns: columns.map((col) => ({
      name: col.key,
      title: col.label,
      ...(col.color ? { color: col.color } : {}),
    })),
  });
  for (const row of rows) {
    table.addRow(row);
  }
  table.printTable();
}

/**
 * Wrap an async operation with a spinner on stderr.
 * The spinner is always stopped in a finally block (even on error).
 */
export async function withSpinner<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const spinner = createSpinner({ text: label, stream: process.stderr });
  spinner.start();
  try {
    const result = await fn();
    spinner.stop();
    return result;
  } catch (err) {
    spinner.stop();
    throw err;
  }
}

/**
 * Color a status string using ansis.
 * open -> green, closed -> dim, blocked -> red, in-progress -> yellow.
 */
export function formatStatus(status: string | null | undefined): string {
  if (status == null) return ansis.dim("unknown");
  switch (status) {
    case "open":
      return ansis.green(status);
    case "closed":
      return ansis.dim(status);
    case "blocked":
      return ansis.red(status);
    case "in-progress":
      return ansis.yellow(status);
    default:
      return status;
  }
}

/**
 * Format epoch milliseconds as a short human-readable timestamp.
 * Format: YYYY-MM-DD HH:mm (local time, no seconds).
 */
export function formatTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

/**
 * Render a tree view of a nested object to stdout.
 */
export function renderTree(data: Record<string, unknown>): void {
  console.log(treeify(data));
}
