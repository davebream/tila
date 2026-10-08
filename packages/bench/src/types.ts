import type { TilaFacade } from "tila-sdk";

export type Tier = "inproc" | "embedded" | "http";

export type OutcomeClass = "ok" | "conflict" | "stale_fence" | "error";

/** One measured operation. Scenarios emit one per facade call they time. */
export interface OpOutcome {
  op: string;
  cls: OutcomeClass;
  latencyMs: number;
  status?: number;
  code?: string;
  message?: string;
}

/** The subset of the SDK facade every tier can provide. */
export type BenchFacade = Pick<
  TilaFacade,
  | "tasks"
  | "records"
  | "claims"
  | "artifacts"
  | "signals"
  | "journal"
  | "presence"
  | "reentry"
  | "summary"
  | "close"
>;

export interface Participant {
  /** 0..N-1 */
  index: number;
  participantId: string;
  /** Project the facade is bound to (needed for raw admin paths). */
  projectId: string;
  /** Server-side principal the participant's credential resolves to. */
  principalId: string;
  tila: BenchFacade;
  /**
   * Raw request against the same backend (admin routes, cold-start probes).
   * Absent on the embedded tier, which has no HTTP surface.
   */
  rawFetch?: (path: string, init?: RequestInit) => Promise<Response>;
}

export type ClaimMode = "exclusive" | "owner";
export type WriteTarget = "tasks" | "records";

export interface ScenarioParams {
  /** Claim mode for contended scenarios. */
  mode: ClaimMode;
  /** Number of disjoint hot resources in claims-contended (1 = everyone on one). */
  groups: number;
  /** How long a winner holds a contended claim before releasing, in ms. */
  holdMs: number;
  /** fenced-writes target. */
  target: WriteTarget;
  /** fenced-writes: the thief takes over a holder's resource every N ops. */
  stealEvery: number;
  /** artifacts: blob sizes in bytes, round-robin. */
  sizesBytes: number[];
  /** journal-replay: number of writer participants (rest are readers). */
  writers?: number;
  /** cold-start: restart iterations. */
  coldStartIterations: number;
}

export interface InvariantResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ScenarioContext {
  runId: string;
  tier: Tier;
  /** Target period per iteration when the run is paced; scenarios may shrink an iteration to one call. */
  cadenceMs?: number;
  seed: number;
  rng: () => number;
  participants: Participant[];
  params: ScenarioParams;
  signal: AbortSignal;
  log: (msg: string) => void;
  /** Free-form per-scenario counters and gauges surfaced in `extra`. */
  extra: Record<string, number>;
}

export interface Scenario {
  name: string;
  description: string;
  tiers: Tier[];
  /** Needs a full-scope token (admin routes). */
  requiresAdmin?: boolean;
  /** Excluded from `all`, `smoke`, and `mix`. */
  explicitOnly?: boolean;
  setup(ctx: ScenarioContext): Promise<void>;
  /** One logical iteration for one participant. Never throws for API errors. */
  op(ctx: ScenarioContext, p: Participant): Promise<OpOutcome[]>;
  /** Best-effort cleanup; must not throw. */
  teardown(ctx: ScenarioContext): Promise<void>;
  /** Dataset description for the result (resources created, sizes, …). */
  dataset?(ctx: ScenarioContext): Record<string, unknown>;
  invariants?(ctx: ScenarioContext, rec: RecorderView): InvariantResult[];
}

/** Read-only view of the recorder a scenario's invariants can inspect. */
export interface RecorderView {
  count(op: string, cls?: OutcomeClass): number;
  total(cls?: OutcomeClass): number;
  ops(): string[];
}

export interface StoreSample {
  db_bytes: number | null;
  counts: Record<string, number>;
}

export interface RegionInfo {
  cf_colo?: string;
  cf_placement?: string;
  user?: string;
}

export interface Driver {
  tier: Tier;
  describe(): {
    base_url_host?: string;
    deployed: boolean;
    region?: RegionInfo;
    notes: string[];
  };
  participants(n: number, principals: number): Promise<Participant[]>;
  sampleStore?(): Promise<StoreSample>;
  sweep?(): Promise<Record<string, number>>;
  restart?(): Promise<void>;
  cleanup(): Promise<void>;
}
