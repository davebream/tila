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
import { TILA_ERRORS } from "tila-sdk";
import createSpinner from "yocto-spinner";
import { EXIT_CODES, exitCodeFor } from "./exit-codes";

import { AsyncLocalStorage } from "node:async_hooks";
import { format, stripVTControlCharacters } from "node:util";
import type {
  CliDiagnostic,
  CliErrorEnvelope,
  CliPageMeta,
  CliSuccessEnvelope,
} from "@tila/schemas";
export type { CliErrorEnvelope, CliSuccessEnvelope } from "@tila/schemas";

type OutputState = {
  json: boolean;
  nonInteractive?: boolean;
  mutating?: boolean;
  limit?: number;
  emitted: boolean;
  failed: boolean;
  messages: string[];
  diagnostics: string[];
};
const outputState = new AsyncLocalStorage<OutputState>();
const pendingWrites = new Set<Promise<void>>();
function writeStdout(value: string | Uint8Array): void {
  const pending = new Promise<void>((resolve, reject) => {
    process.stdout.write(value, (error) => (error ? reject(error) : resolve()));
  });
  pendingWrites.add(pending);
  void pending.then(
    () => pendingWrites.delete(pending),
    () => {},
  );
}
export async function flushOutput(): Promise<void> {
  await Promise.all(pendingWrites);
}
export function currentOutput() {
  return outputState.getStore();
}
export async function withOutput<T>(
  options: Pick<OutputState, "json" | "nonInteractive" | "mutating" | "limit">,
  run: () => Promise<T>,
): Promise<T> {
  return outputState.run(
    {
      ...options,
      emitted: false,
      failed: false,
      messages: [],
      diagnostics: [],
    },
    async () => {
      const value = await run();
      const state = currentOutput();
      if (state?.json && !state.emitted)
        printJsonSuccess(
          state.messages.length ? { messages: state.messages } : {},
        );
      return value;
    },
  );
}
export function canPrompt(): boolean {
  const state = currentOutput();
  return (
    !state?.json &&
    !state?.nonInteractive &&
    !process.env.CI &&
    Boolean(process.stdin.isTTY)
  );
}
export function requirePrompt(
  hint = "Supply the required input using command flags.",
): void {
  if (!canPrompt())
    throw Object.assign(
      new Error(
        `Interactive input required. ${hint} Use --help for available input flags.`,
      ),
      {
        code: "input-required",
      },
    );
}
export function outputText(...args: unknown[]): void {
  const state = currentOutput();
  const message = format(...args);
  if (state?.json) state.messages.push(stripVTControlCharacters(message));
  else
    console.log(
      process.stdout.isTTY && !process.env.NO_COLOR
        ? message
        : stripVTControlCharacters(message),
    );
}
export function warning(...args: unknown[]): void {
  const message = stripVTControlCharacters(format(...args));
  console.warn(
    currentOutput()?.json
      ? JSON.stringify({
          type: "diagnostic",
          level: "warning",
          message,
        } satisfies CliDiagnostic)
      : message,
  );
}
export function diagnostic(...args: unknown[]): void {
  const message = stripVTControlCharacters(format(...args));
  currentOutput()?.diagnostics.push(message);
  console.error(
    currentOutput()?.json
      ? JSON.stringify({
          type: "diagnostic",
          level: "info",
          message,
        } satisfies CliDiagnostic)
      : message,
  );
}
/** Explicit bypass for external protocols, tokens, and downloaded bytes. */
export function rawOutput(value: string | Uint8Array): void {
  const state = currentOutput();
  if (state) state.emitted = true;
  writeStdout(value);
}
export function protocolJson(value: unknown): void {
  rawOutput(`${JSON.stringify(value)}\n`);
}
/** Adapter for older handlers that construct JSON text; never use for protocols. */
export function jsonText(value: string): void {
  const data = JSON.parse(value);
  if (data.ok === false)
    emitError(
      "partial-failure",
      "The operation did not fully complete",
      undefined,
      data,
    );
  else printJson(data);
}
export function exit(code = 0): never {
  const state = currentOutput();
  if (state?.json && !state.emitted) {
    if (code)
      emitError(
        "command-failed",
        state.diagnostics.at(-1) ?? "Command failed",
        undefined,
        { diagnostics: state.diagnostics },
      );
    else
      printJsonSuccess(
        state.messages.length ? { messages: state.messages } : {},
      );
  }
  process.exit(code);
}

const collectionKeys = [
  "items",
  "templates",
  "gates",
  "service_accounts",
  "bindings",
  "entities",
  "records",
  "signals",
  "groups",
  "results",
  "events",
  "artifacts",
  "tokens",
  "instances",
  "projects",
  "types",
  "relationships",
  "revisions",
  "entries",
  "claims",
  "participants",
  "machines",
  "refs",
  "repos",
];
export function successEnvelope(data: unknown): CliSuccessEnvelope<unknown> {
  let result = data;
  let meta: CliPageMeta = {};
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const { ok: _ok, meta: page, ...rest } = data as Record<string, unknown>;
    meta = page && typeof page === "object" ? { ...page } : {};
    result =
      Object.keys(rest).length === 1 && "result" in rest ? rest.result : rest;
  }
  if (Array.isArray(result)) result = { items: result };
  if (result && typeof result === "object") {
    const body = { ...result } as Record<string, unknown>;
    const candidates = collectionKeys.filter((key) => Array.isArray(body[key]));
    const collection =
      candidates.length === 1 && !("resolved" in body)
        ? candidates[0]
        : undefined;
    if (collection) {
      const items = body[collection] as unknown[];
      delete body[collection];
      for (const key of [
        "total",
        "limit",
        "offset",
        "next_cursor",
        "next_revision",
        "truncated",
      ]) {
        if (body[key] !== undefined) {
          meta[key] = body[key];
          delete body[key];
        }
      }
      body.count = undefined;
      const limit =
        currentOutput()?.limit ??
        (typeof meta.limit === "number" ? meta.limit : 100);
      body.items = items.slice(0, limit);
      meta = { ...meta, count: (body.items as unknown[]).length, limit };
      if (meta.next_cursor === "truncated") {
        meta.next_cursor = undefined;
        meta.truncated = true;
      }
      // Without a cursor or total a full page cannot prove completeness.
      if (
        items.length === limit &&
        meta.total === undefined &&
        !("next_cursor" in meta) &&
        !("next_revision" in meta)
      )
        meta.has_more_unknown = true;
      if (
        items.length > limit ||
        meta.next_cursor ||
        meta.next_revision ||
        (meta.total !== undefined &&
          meta.total > (meta.offset ?? 0) + items.length)
      )
        meta.truncated = true;
      result = body;
    }
  }
  return {
    ok: true,
    result: result ?? null,
    ...(Object.keys(meta).length ? { meta } : {}),
  };
}
function emitError(
  kind: string,
  message: string,
  hint?: string,
  details?: unknown,
): void {
  const state = currentOutput();
  if (state) {
    state.emitted = true;
    state.failed = true;
  }
  const envelope: CliErrorEnvelope = {
    ok: false,
    error: {
      kind,
      message: stripVTControlCharacters(message),
      retryable:
        exitCodeFor(kind) === EXIT_CODES.NETWORK_ERROR &&
        state?.mutating === false,
      ...(hint ? { hint: stripVTControlCharacters(hint) } : {}),
      ...(details === undefined ? {} : { details }),
    },
  };
  console.error(JSON.stringify(envelope));
}

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
 * Serialize a compact success envelope to stdout.
 * Use for successful command output in --json mode.
 */
export function printJson(data: unknown): void {
  const state = currentOutput();
  if (state) state.emitted = true;
  const document = JSON.stringify(successEnvelope(data));
  if (currentOutput()) writeStdout(`${document}\n`);
  else console.log(document);
}
export function printJsonSuccess<T>(result: T): void {
  printJson(result);
}
export function printJsonError(
  error: string,
  code: string,
  hint?: string,
  exitCode = 1,
  details?: unknown,
): never {
  emitError(code, error, hint, details);
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
    hint?: string;
    issues?: { path: (string | number)[]; message: string }[];
  };
  if (e?.name === "ZodError" && Array.isArray(e.issues)) {
    return {
      code: "invalid-argument",
      message: e.issues
        .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
        .join("; "),
      hint: "Check the input values against --help or tila schema.",
    };
  }
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
  const hint =
    _remediationHint(code) ??
    e?.hint ??
    (/^(No API token found|No tila project found|Invalid config at)/.test(raw)
      ? raw.split("\n").slice(1).join("\n").trim()
      : undefined);
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
    if (currentOutput()?.mutating === true)
      return "Check whether the operation completed before trying again.";
    switch (code) {
      case TILA_ERRORS.RATE_LIMITED:
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
  if (json || currentOutput()?.json) {
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
export function boundedItems<T>(items: T[]): T[] {
  const limit = currentOutput()?.limit ?? 100;
  if (items.length > limit)
    diagnostic(
      `Showing ${limit} of ${items.length} results. Increase --limit to see more.`,
    );
  return items.slice(0, limit);
}
export function renderTable(
  rows: Record<string, unknown>[],
  columns: { key: string; label: string; color?: string }[],
  opts?: { title?: string },
): void {
  if (currentOutput()?.json) {
    printJson(rows);
    return;
  }
  if (rows.length === 0) return;
  const table = new Table({
    title: opts?.title,
    columns: columns.map((col) => ({
      name: col.key,
      title: col.label,
      ...(col.color ? { color: col.color } : {}),
    })),
  });
  for (const row of boundedItems(rows)) {
    table.addRow(row);
  }
  outputText(table.render());
}

/**
 * Wrap an async operation with a spinner on stderr.
 * The spinner is always stopped in a finally block (even on error).
 */
export async function withSpinner<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (currentOutput()?.json || !process.stderr.isTTY || process.env.CI)
    return fn();
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
  outputText(treeify(data));
}

// --- Auth-store output helpers (WI-L) ---

/**
 * Write a message to stderr with a trailing newline.
 * Use for agent-facing commands that must keep stdout clean (e.g. `auth token`).
 */
export function eprintln(msg: string): void {
  if (currentOutput()?.json) diagnostic(msg);
  else process.stderr.write(`${msg}\n`);
}

/**
 * Serialize data as JSON to stderr with 2-space indentation and a trailing newline.
 * Use for error/diagnostic JSON that must not contaminate stdout.
 */
export function eprintJson(data: unknown): void {
  const value = data as Record<string, unknown>;
  if (value?.ok === false || value?.error) {
    const err =
      typeof value.error === "object" && value.error
        ? (value.error as Record<string, unknown>)
        : value;
    emitError(
      String(err.code ?? value.code ?? "command-failed"),
      String(err.message ?? value.message ?? value.error ?? "Command failed"),
      typeof value.hint === "string" ? value.hint : undefined,
      value,
    );
  } else process.stderr.write(`${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Format an epoch-millisecond timestamp as a relative human-readable expiry string.
 *
 * Input is epoch MILLISECONDS (matching CredentialRecord.expires_at).
 * Do NOT pass epoch seconds here — that produces a 1000× wrong result.
 *
 * Returns:
 * - "no expiry" for null
 * - "expired" for past timestamps
 * - "in Nm" or "in Nh Nm" for future timestamps
 */
export function formatExpiry(expiresAtMs: number | null): string {
  if (expiresAtMs === null) return ansis.dim("no expiry");

  const diffMs = expiresAtMs - Date.now();
  if (diffMs <= 0) return ansis.red("expired");

  const totalMinutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) {
    return ansis.green(`in ${hours}h ${minutes}m`);
  }
  return ansis.yellow(`in ${minutes}m`);
}

/**
 * Format a TrustDecision as a colored one-word badge.
 * trusted=green, untrusted/spoof=red, ci-*=yellow
 */
export function formatTrust(
  decision: import("@tila/auth-store").TrustDecision,
): string {
  switch (decision.kind) {
    case "trusted":
      return ansis.green("trusted");
    case "untrusted-needs-login":
      return ansis.red(`untrusted (${decision.reason})`);
    case "spoof-worker-url-mismatch":
      return ansis.red("spoof-url-mismatch");
    case "ci-home-store-disabled":
      return ansis.yellow("ci-home-store-disabled");
    case "ci-tila-home-untrusted":
      return ansis.yellow("ci-home-untrusted");
  }
}

/**
 * Format the "resolves here?" marker for auth status display.
 * Returns a colored bullet (●=active, ○=inactive).
 */
export function formatResolvesHere(isActive: boolean): string {
  return isActive ? ansis.green("● yes") : ansis.dim("○ no");
}
