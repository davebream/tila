/**
 * Instance resolver (WI-J2) — the imperative shell over the pure trust / CI core.
 *
 * `resolveWithTrace` walks the precedence chain (flag → env → repo-pointer →
 * current-context), evaluates each named candidate through the CI gate then the
 * trust gate, and FAILS CLOSED on any non-trusted candidate (it never falls
 * through to a weaker rung). It never throws. `resolveInstance` is the throwing
 * wrapper used by command code.
 *
 * Project identity is resolved INDEPENDENTLY by the caller — this module only
 * decides the instance + credential.
 */

import type { InstanceKey, InstanceRecord } from "@tila/schemas";
import { evaluateCiPolicy } from "./ci-policy.js";
import { InstanceResolutionError } from "./errors.js";
import { readLegacyCredential } from "./legacy-reader.js";
import type {
  InstanceCandidate,
  ResolutionSource,
  ResolveInput,
  ResolveOutcome,
  ResolvedInstance,
  TraceStep,
  TrustDecision,
} from "./resolver-types.js";
import { evaluateTrust } from "./trust.js";

const RUNG_ORDER: ResolutionSource[] = [
  "flag",
  "env",
  "repo-pointer",
  "current-context",
  "legacy-fallback",
];

/** What a rung produced: nothing, or a candidate (+ optional inline token). */
type RungResult =
  | { matched: false; detail: string }
  | {
      matched: true;
      candidate: InstanceCandidate;
      record: InstanceRecord | null;
      token?: string;
      detail: string;
    };

/** The active worker_url an inline token targets (flag, else cwd repo config). */
function activeWorkerUrl(input: ResolveInput): string | null {
  return input.flags?.workerUrl ?? input.repoPointer?.worker_url ?? null;
}

async function lookupRecord(
  input: ResolveInput,
  key: InstanceKey,
): Promise<InstanceRecord | null> {
  return input.authStore.getInstance(key);
}

// ---------------------------------------------------------------------------
// Per-rung candidate builders (each returns matched=false to continue the walk)
// ---------------------------------------------------------------------------

async function buildFlagRung(input: ResolveInput): Promise<RungResult> {
  const flags = input.flags;
  if (flags?.token) {
    const url = activeWorkerUrl(input);
    return {
      matched: true,
      candidate: {
        worker_url: url ?? "",
        instance_key: null,
        inlineToken: true,
      },
      record: null,
      token: flags.token,
      detail: "--token flag set",
    };
  }
  if (flags?.instance) {
    const key = flags.instance as InstanceKey;
    const record = await lookupRecord(input, key);
    return {
      matched: true,
      candidate: {
        worker_url: record?.worker_url ?? "",
        instance_key: key,
        inlineToken: false,
      },
      record,
      detail: `--instance ${key}`,
    };
  }
  return { matched: false, detail: "no --instance/--token flag" };
}

async function buildEnvRung(input: ResolveInput): Promise<RungResult> {
  const token = input.envReader("TILA_TOKEN");
  if (token) {
    const url = activeWorkerUrl(input);
    return {
      matched: true,
      candidate: {
        worker_url: url ?? "",
        instance_key: null,
        inlineToken: true,
      },
      record: null,
      token,
      detail: "TILA_TOKEN env set",
    };
  }
  const instance = input.envReader("TILA_INSTANCE");
  if (instance) {
    const key = instance as InstanceKey;
    const record = await lookupRecord(input, key);
    return {
      matched: true,
      candidate: {
        worker_url: record?.worker_url ?? "",
        instance_key: key,
        inlineToken: false,
      },
      record,
      detail: `TILA_INSTANCE=${key}`,
    };
  }
  if (input.envReader("TILA_CONFIG")) {
    const pointer = input.envConfigPointer ?? null;
    if (!pointer) {
      return {
        matched: false,
        detail: "TILA_CONFIG set but no instance pointer was parsed from it",
      };
    }
    const record = pointer.instance_key
      ? await lookupRecord(input, pointer.instance_key)
      : null;
    return {
      matched: true,
      candidate: {
        worker_url: pointer.worker_url,
        instance_key: pointer.instance_key,
        inlineToken: false,
      },
      record,
      detail: "TILA_CONFIG instance pointer",
    };
  }
  return {
    matched: false,
    detail: "no TILA_TOKEN/TILA_INSTANCE/TILA_CONFIG env",
  };
}

async function buildRepoPointerRung(input: ResolveInput): Promise<RungResult> {
  const pointer = input.repoPointer;
  if (!pointer || !pointer.instance_key) {
    return {
      matched: false,
      detail: "no repo .tila/config.toml instance pointer",
    };
  }
  const record = await lookupRecord(input, pointer.instance_key);
  return {
    matched: true,
    candidate: {
      worker_url: pointer.worker_url,
      instance_key: pointer.instance_key,
      inlineToken: false,
    },
    record,
    detail: `repo pointer instance_key=${pointer.instance_key}`,
  };
}

async function buildCurrentContextRung(
  input: ResolveInput,
): Promise<RungResult> {
  const key = await input.authStore.getCurrentContext();
  if (!key) {
    return { matched: false, detail: "no registry current_context" };
  }
  const record = await lookupRecord(input, key);
  return {
    matched: true,
    candidate: {
      worker_url: record?.worker_url ?? "",
      instance_key: key,
      inlineToken: false,
    },
    record,
    detail: `current_context=${key}`,
  };
}

/**
 * Lowest-priority fallback rung for legacy .tila/.env / .tila/.session credentials (WI-M).
 *
 * Constraints (normative):
 * - MUST NOT call any input.authStore method — data comes only from legacy-reader + repoPointer.
 * - TraceStep.detail MUST NOT contain the token value — use source path only.
 * - Wraps readLegacyCredential in try/catch → matched:false on corruption (preserves never-throws).
 * - Uses inlineToken:true so trust.ts Rule 1 + ci-policy.ts exemption apply unchanged.
 */
async function buildLegacyFallbackRung(
  input: ResolveInput,
): Promise<RungResult> {
  if (!input.legacy) {
    return { matched: false, detail: "no legacy locations provided" };
  }

  let cred: ReturnType<typeof readLegacyCredential>;
  try {
    cred = readLegacyCredential(input.legacy);
  } catch (err) {
    // Corrupt file — record detail with no raw file content, no token
    const msg = err instanceof Error ? err.message : String(err);
    // Strip the token from the message (e.g., if somehow included)
    const safeMsg = msg.replace(/token[^\s]*/gi, "<redacted>");
    return {
      matched: false,
      detail: `legacy credential file corrupt — ${safeMsg}`,
    };
  }

  if (!cred) {
    return {
      matched: false,
      detail: "no usable legacy .tila/.env or .tila/.session found",
    };
  }

  // Derive worker_url from repoPointer only — never fabricate a URL
  const workerUrl = input.repoPointer?.worker_url ?? null;
  if (!workerUrl) {
    return {
      matched: false,
      detail:
        "legacy credential found but no worker_url derivable (no repo pointer); " +
        "run inside a tila project directory or set TILA_CONFIG",
    };
  }

  // Use source_path for the detail, never the token itself
  return {
    matched: true,
    candidate: {
      worker_url: workerUrl,
      instance_key: null,
      inlineToken: true,
      legacy: true,
    },
    record: null,
    token: cred.token,
    detail: `legacy ${cred.source_path} (${cred.kind})`,
  };
}

function buildRung(
  rung: ResolutionSource,
  input: ResolveInput,
): Promise<RungResult> {
  switch (rung) {
    case "flag":
      return buildFlagRung(input);
    case "env":
      return buildEnvRung(input);
    case "repo-pointer":
      return buildRepoPointerRung(input);
    case "current-context":
      return buildCurrentContextRung(input);
    case "legacy-fallback":
      return buildLegacyFallbackRung(input);
  }
}

// ---------------------------------------------------------------------------
// Error construction (actionable messages)
// ---------------------------------------------------------------------------

function toError(
  decision: TrustDecision,
  candidate: InstanceCandidate,
): InstanceResolutionError {
  switch (decision.kind) {
    case "untrusted-needs-login":
      if (decision.reason === "unregistered") {
        return new InstanceResolutionError(
          `Instance for worker_url "${candidate.worker_url}" is not registered. Run \`tila auth login\` to register and trust it before sending credentials.`,
          decision,
        );
      }
      return new InstanceResolutionError(
        `Instance "${candidate.instance_key}" is registered but not trusted. Run \`tila auth login\` to trust it.`,
        decision,
      );
    case "spoof-worker-url-mismatch":
      return new InstanceResolutionError(
        `Refusing to use a credential: config presents worker_url "${decision.presented}" but instance "${candidate.instance_key}" is trusted for "${decision.registered}" (possible spoof). Run \`tila auth login\` against the intended instance.`,
        decision,
      );
    case "ci-home-store-disabled":
      return new InstanceResolutionError(
        "Home-store credentials are disabled under CI / non-TTY. " +
          "Provide --token or TILA_TOKEN, or use the GitHub Actions OIDC flow.",
        decision,
      );
    case "ci-tila-home-untrusted":
      return new InstanceResolutionError(
        "TILA_HOME is overridden under CI — the home registry is treated as untrusted. " +
          "Provide --token or TILA_TOKEN instead of relying on the home store.",
        decision,
      );
    case "trusted":
      // Unreachable — trusted candidates do not produce an error.
      return new InstanceResolutionError(
        "Internal: trusted decision passed to toError",
        decision,
      );
  }
}

// ---------------------------------------------------------------------------
// Credential assembly for a trusted candidate
// ---------------------------------------------------------------------------

async function assemble(
  rung: RungResult & { matched: true },
  input: ResolveInput,
): Promise<
  | { ok: true; instance: ResolvedInstance }
  | { ok: false; error: InstanceResolutionError }
> {
  const { candidate, token, record } = rung;

  if (candidate.inlineToken) {
    if (!candidate.worker_url) {
      return {
        ok: false,
        error: new InstanceResolutionError(
          "An inline token was provided but no worker_url could be resolved to target it. " +
            "Run inside a tila project, or set TILA_CONFIG / pass the project's worker_url.",
          "none",
        ),
      };
    }

    // Legacy-fallback branch: emit credentialSource "legacy" to distinguish from an
    // explicit --token / TILA_TOKEN inline token.
    if (candidate.legacy) {
      return {
        ok: true,
        instance: {
          instance_key: null,
          worker_url: candidate.worker_url,
          credentialSource: "legacy",
          credential: { source: "legacy", token: token as string },
          trust: { kind: "trusted" },
        },
      };
    }

    return {
      ok: true,
      instance: {
        instance_key: null,
        worker_url: candidate.worker_url,
        credentialSource: "inline-token",
        credential: { source: "inline-token", token: token as string },
        trust: { kind: "trusted" },
      },
    };
  }

  // Registry rung: the key is present and (trusted ⇒) the record exists.
  const key = candidate.instance_key as InstanceKey;
  const credentialRecord = await input.authStore.getCredential(key);
  if (credentialRecord === null) {
    return {
      ok: false,
      error: new InstanceResolutionError(
        `No (unexpired) credential is stored for instance "${key}". Run \`tila auth login\` to obtain one.`,
        "none",
      ),
    };
  }
  return {
    ok: true,
    instance: {
      instance_key: key,
      worker_url: record?.worker_url ?? candidate.worker_url,
      credentialSource: "keychain",
      credential: { source: "keychain", record: credentialRecord },
      trust: { kind: "trusted" },
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve an instance + credential with a full per-rung trace. NEVER throws —
 * keychain access failures and binding mismatches surface as a failed outcome
 * so `tila doctor` / `status` can always render a diagnosis.
 */
export async function resolveWithTrace(
  input: ResolveInput,
): Promise<ResolveOutcome> {
  const trace: TraceStep[] = [];

  for (const rung of RUNG_ORDER) {
    let built: RungResult;
    try {
      built = await buildRung(rung, input);
    } catch (err) {
      // A registry/keychain read failed while building this rung — fail closed.
      trace.push({
        rung,
        attempted: true,
        matched: false,
        detail: `error building rung: ${(err as Error).message}`,
      });
      return {
        ok: false,
        error: new InstanceResolutionError(
          `Instance resolution failed at the ${rung} rung: ${(err as Error).message}`,
          "none",
        ),
        trace,
      };
    }

    if (!built.matched) {
      trace.push({
        rung,
        attempted: true,
        matched: false,
        detail: built.detail,
      });
      continue;
    }

    // A candidate is NAMED on this rung. It must resolve to trusted or fail
    // closed — it never falls through to a weaker rung.
    const ciDecision = evaluateCiPolicy(input.env, built.candidate);
    const decision = ciDecision ?? evaluateTrust(built.candidate, built.record);
    trace.push({
      rung,
      attempted: true,
      matched: true,
      detail: built.detail,
      trust: decision,
    });

    if (decision.kind !== "trusted") {
      return { ok: false, error: toError(decision, built.candidate), trace };
    }

    try {
      const assembled = await assemble(built, input);
      if (!assembled.ok) {
        return { ok: false, error: assembled.error, trace };
      }
      return { ok: true, instance: assembled.instance, trace };
    } catch (err) {
      // getCredential threw (KeychainUnavailableError / InstanceKeyMismatchError).
      return {
        ok: false,
        error: new InstanceResolutionError(
          `Credential lookup failed for the ${rung} rung: ${(err as Error).message}`,
          "none",
        ),
        trace,
      };
    }
  }

  return {
    ok: false,
    error: new InstanceResolutionError(
      "No tila instance could be resolved. Tried: --instance/--token flag, " +
        "TILA_INSTANCE/TILA_TOKEN/TILA_CONFIG env, repo .tila/config.toml pointer, " +
        "and registry current_context. Run `tila auth login`, or pass --token/--instance.",
      "none",
    ),
    trace,
  };
}

/** Resolve an instance, throwing InstanceResolutionError on failure. */
export async function resolveInstance(
  input: ResolveInput,
): Promise<ResolvedInstance> {
  const outcome = await resolveWithTrace(input);
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.instance;
}
