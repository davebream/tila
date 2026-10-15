import { lifecycleDefinition } from "./readiness-fixture";

/**
 * Work types for the compact-queue fixtures: `issue` keeps its `phase`
 * lifecycle from the shared readiness fixture and gains the content fields a
 * managed task carries; `ticket` has a differently named lifecycle field.
 */
export const compactDefinition = `${lifecycleDefinition}
[work_units.issue.fields.title]
type = "string"
[work_units.issue.fields.name]
type = "string"
[work_units.issue.fields.description]
type = "text"
[work_units.issue.fields.acceptance]
type = "text"
[work_units.issue.fields.notes]
type = "text"
[work_units.ticket.fields.state]
type = "enum"
values = ["open", "done"]
[work_units.ticket.fields.title]
type = "string"
[work_units.ticket.fields.description]
type = "text"
[work_units.ticket.lifecycle]
field = "state"
dispatchable = ["open"]
terminal = ["done"]
dependency_satisfied = ["done"]
`;

const WORDS = [
  "update",
  "the",
  "module",
  "and",
  "its",
  "callers",
  "extend",
  "matching",
  "tests",
  "verify",
  "queue",
  "entry",
  "task",
  "lifecycle",
  "field",
  "title",
  "state",
  "readiness",
  "claim",
  "attempt",
  "session",
  "worker",
  "adapter",
  "schema",
  "revision",
  "migration",
  "index",
  "route",
  "handler",
  "response",
  "payload",
  "client",
  "dashboard",
  "page",
  "count",
  "filter",
  "cursor",
  "limit",
  "policy",
  "capacity",
  "execution",
  "resource",
  "credential",
  "scope",
  "capability",
  "permission",
  "document",
  "release",
  "baseline",
];

/** Deterministic ASCII prose of exactly `bytes` bytes (one byte per char). */
export function prose(seed: number, bytes: number): string {
  let state = ((seed + 1) * 2_654_435_761) % 2 ** 32;
  let out = "";
  while (out.length < bytes) {
    state = (state * 1_664_525 + 1_013_904_223) % 2 ** 32;
    out += WORDS[state % WORDS.length] + (state % 11 === 0 ? ". " : " ");
  }
  return out.slice(0, bytes);
}

/**
 * One managed-work task. `bodyBytes` is the content beyond the title and
 * lifecycle state, split into the description (60%), acceptance criteria
 * (25%) and notes (15%), as separate fields rather than one blob.
 *
 * The issue this slice answers observed about 575 KB for 100 tasks, about
 * 5.7 KB per entry. An entry, its attempt slot and the response wrapper cost
 * about 0.6 KB of that and a task's stored metadata about 0.15 KB, so a
 * realistic body there is about 5 KB: the default.
 */
export function managedWork(
  index: number,
  bodyBytes = 5_000,
): Record<string, unknown> {
  return {
    phase: "todo",
    title: `Work item ${index}: ${prose(index, 40).trim()}`,
    description: prose(index * 3 + 1, Math.round(bodyBytes * 0.6)),
    acceptance: prose(index * 3 + 2, Math.round(bodyBytes * 0.25)),
    notes: prose(index * 3 + 3, Math.round(bodyBytes * 0.15)),
  };
}

export const jsonBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
