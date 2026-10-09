import { selectedProfile } from "@tila/client-lifecycle";
import {
  SessionStore,
  brokerReference,
  connectRuntimeBroker,
  sessionKey,
} from "@tila/client-lifecycle";
import { TokenProviderError } from "tila-sdk";
import { findConfig } from "../config";
import { getGlobalFlags } from "./global-flags";

/** Native hooks and explicit run exec converge on the same run capability. */
export async function managedRuntime() {
  let reference:
    | import("@tila/client-lifecycle").RuntimeBrokerReference
    | undefined;
  if (process.env.TILA_RUN_SOCKET || process.env.TILA_RUN_CAPABILITY)
    reference = brokerReference();
  else if (process.env.TILA_LIFECYCLE_KEY || process.env.CODEX_THREAD_ID) {
    const config = findConfig();
    if (!config?.worker_url)
      throw new TokenProviderError(
        "runtime-session-unavailable",
        "Session project configuration is missing",
      );
    const namespace = JSON.stringify([
      config.worker_url.replace(/\/+$/, ""),
      config.project_id,
    ]);
    const key =
      process.env.TILA_LIFECYCLE_KEY ??
      sessionKey(
        namespace,
        "codex",
        process.env.CODEX_THREAD_ID ?? "",
        selectedProfile(),
      );
    const state = new SessionStore().read(key);
    if (
      !state ||
      state.phase !== "active" ||
      state.namespace !== namespace ||
      !state.runtime
    )
      throw new TokenProviderError(
        "runtime-session-unavailable",
        "Session has no active runtime mapping",
      );
    reference = state.runtime;
  }
  if (!reference) return null;
  const run = await connectRuntimeBroker(reference);
  const flags = getGlobalFlags();
  if (
    flags.token ||
    process.env.TILA_API_TOKEN ||
    process.env.TILA_TOKEN ||
    (flags.project && flags.project !== run.context.project_id) ||
    (flags.participantId &&
      flags.participantId !== run.context.participant_id) ||
    (process.env.TILA_PARTICIPANT_ID &&
      process.env.TILA_PARTICIPANT_ID !== run.context.participant_id) ||
    (flags.instance && flags.instance !== run.deployment)
  )
    throw new TokenProviderError(
      "runtime-binding-mismatch",
      "Managed commands cannot override credentials, project, deployment, or participant",
    );
  return run;
}
