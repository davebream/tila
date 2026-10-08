import type { Scenario } from "../types";
import { artifacts } from "./artifacts";
import { claimsContended } from "./claims-contended";
import { claimsUncontended } from "./claims-uncontended";
import { coldStart } from "./cold-start";
import { fencedWrites } from "./fenced-writes";
import { journalReplay } from "./journal-replay";
import { presenceSignals } from "./presence-signals";

export const SCENARIOS: readonly Scenario[] = [
  claimsUncontended,
  claimsContended,
  fencedWrites,
  presenceSignals,
  journalReplay,
  artifacts,
  coldStart,
];

/** Scenarios that run concurrently under `--scenario mix` (soak default). */
export const MIX = [
  "claims-contended",
  "fenced-writes",
  "presence-signals",
  "journal-replay",
];

export function scenarioByName(name: string): Scenario {
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s)
    throw new Error(
      `Unknown scenario "${name}". Known: ${SCENARIOS.map((x) => x.name).join(", ")}, all, mix`,
    );
  return s;
}

export function resolveScenarios(selector: string): Scenario[] {
  if (selector === "all") return SCENARIOS.filter((s) => !s.explicitOnly);
  if (selector === "mix") return MIX.map(scenarioByName);
  return selector.split(",").map((n) => scenarioByName(n.trim()));
}
