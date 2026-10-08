import {
  type TilaClient,
  createArtifactMethods,
  createClaimMethods,
  createJournalMethods,
  createPresenceMethods,
  createRecordMethods,
  createReentryMethod,
  createSignalMethods,
  createSummaryMethods,
  createTaskMethods,
} from "tila-sdk";
import type { BenchFacade } from "../types";

/** Build the bench-facing facade from an HTTP (or custom-fetch) client. */
export function facadeFromClient(
  client: TilaClient,
  projectId: string,
): BenchFacade {
  return {
    tasks: createTaskMethods(client, projectId),
    records: createRecordMethods(client, projectId),
    claims: createClaimMethods(client, projectId),
    artifacts: createArtifactMethods(client, projectId),
    signals: createSignalMethods(client, projectId),
    journal: createJournalMethods(client, projectId),
    presence: createPresenceMethods(client, projectId),
    reentry: createReentryMethod(client, projectId),
    summary: createSummaryMethods(client, projectId),
    close: () => {},
  };
}
