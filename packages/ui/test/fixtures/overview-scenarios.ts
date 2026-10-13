import type { AppliedSchemaResponse } from "@/lib/api";
import type { RecordCatalogEntry, WorkCatalogEntry } from "@tila/schemas";
import { emptyQueue } from "../mocks/handlers";
import { recordEntry } from "../mocks/records";
import { declaredEntry } from "../mocks/tasks";

// Scenario fixtures for the Overview's attention rules (#306). Each describes
// the server state a scenario user meets and what the Overview must conclude.
// The pure rule tests and the rendered page tests share them.

export interface OverviewScenario {
  name: string;
  schema: AppliedSchemaResponse;
  work: WorkCatalogEntry[];
  records: RecordCatalogEntry[];
  /** `null`: the queue request fails with a 503. */
  queue: ReturnType<typeof emptyQueue> | null;
  expected: "setup" | "attention" | "idle" | "unknown";
  /** The next action's link when `expected` is "attention". */
  next?: string;
}

const applied: AppliedSchemaResponse = {
  ok: true,
  schema: {
    version: 3,
    definition:
      '[work_units.bug]\nfields = [{ name = "title", type = "string" }]\n',
    applied_at: Date.now() - 3_600_000,
    applied_by: "owner@example.test",
  },
  version: 3,
  revision: 3,
};

const notApplied: AppliedSchemaResponse = {
  ok: true,
  schema: null,
  version: null,
  revision: 0,
};

export const SCENARIOS: OverviewScenario[] = [
  {
    // S1: a solo developer opens a project created without a schema file.
    name: "S1 new project without definitions or data",
    schema: notApplied,
    work: [],
    records: [],
    queue: emptyQueue(),
    expected: "setup",
  },
  {
    // S1 later: definitions applied, an empty declared type, nothing queued.
    name: "S1 configured project with nothing to do",
    schema: applied,
    work: [declaredEntry("bug", 0)],
    records: [recordEntry("config", 0)],
    queue: emptyQueue(),
    expected: "idle",
  },
  {
    // S2: a worker lost its session mid-run; the outcome is unknown.
    name: "S2 execution outcome uncertain after a lost session",
    schema: applied,
    work: [declaredEntry("bug", 4)],
    records: [],
    queue: emptyQueue({ uncertain: 2, suspended: 1, active: 1 }),
    expected: "attention",
    next: "/p/test-project/queue?state=uncertain",
  },
  {
    // S3: during a hotfix the queue store is unreachable.
    name: "S3 queue outage during a hotfix",
    schema: applied,
    work: [declaredEntry("bug", 4)],
    records: [],
    queue: null,
    expected: "unknown",
  },
  {
    // A project with tasks but no definitions is in use, not a new project.
    name: "Tasks written without definitions",
    schema: notApplied,
    work: [{ ...declaredEntry("task", 2), declaration: "undeclared" }],
    records: [],
    queue: emptyQueue({ suspended: 3 }),
    expected: "attention",
    next: "/p/test-project/queue?state=suspended",
  },
];
