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

// --- Existing utilities (unchanged) ---

/**
 * Serialize data as JSON to stdout with 2-space indentation.
 * Use for successful command output in --json mode.
 */
export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Serialize an error as JSON to stderr and exit with code 1.
 * Use for error output in --json mode.
 *
 * @param error - Human-readable error message
 * @param code - Machine-readable error code (e.g. "NOT_FOUND", "NETWORK_ERROR")
 * @param details - Optional additional error context
 */
export function printJsonError(
  error: string,
  code: string,
  details?: unknown,
): never {
  console.error(
    JSON.stringify(
      { error, code, ...(details !== undefined ? { details } : {}) },
      null,
      2,
    ),
  );
  process.exit(1);
}

/**
 * Convert Unix epoch milliseconds to ISO 8601 string.
 * Token timestamps use epoch seconds -- multiply by 1000 before calling this.
 */
export function tsToIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
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
