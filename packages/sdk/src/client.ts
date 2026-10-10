import {
  type EnvironmentMetadata,
  EnvironmentMetadataSchema,
  ErrorEnvelopeSchema,
  ParticipantIdSchema,
  type TilaProjectConfig,
  accessTokenHash,
  canonicalizeHtu,
} from "@tila/schemas";
import type { z } from "zod";
import { abortable } from "./abort";
import { createArtifactMethods } from "./artifacts";
import { createClaimMethods } from "./claims";
import { createHandoffMethods, createReentryMethod } from "./continuity";
import { providerProof } from "./dpop";
import { createTaskMethods } from "./entities";
import { toTilaErrorCode } from "./error-codes";
import { TilaApiError, isTilaApiError, readApiError } from "./errors";
import {
  CredentialManager,
  type TokenCredential,
  type TokenProvider,
  TokenProviderError,
} from "./token-provider";
export { TilaApiError, isTilaApiError } from "./errors";
import { createAgentMethods } from "./agents";
import { createGateMethods } from "./gates";
import { createIndexMethods } from "./indexes";
import { createJournalMethods } from "./journal";
import { createPresenceMethods } from "./presence";
import { createRecordMethods } from "./records";
import { createSchemaMethods } from "./schema";
import { createSearchMethods } from "./search";
import { createServiceAccountMethods } from "./service-accounts";
import { createSignalMethods } from "./signals";
import { createSummaryMethods } from "./summary";
import { createTemplateMethods } from "./templates";
import { createTokenMethods } from "./tokens";
import { SDK_VERSION } from "./version";

export interface ClientOptions {
  baseUrl: string;
  token: string | TokenProvider;
  /** Refresh this far ahead of expiry. Default: 30000 milliseconds. */
  expirySkewMs?: number;
  validate?: boolean;
  /** Request timeout in milliseconds. Default: 30000 (30s). */
  timeoutMs?: number;
  /** Stable identity for this independent client session. Defaults to a UUID. */
  participantId?: string;
  /** Untrusted environment metadata reported with each request. */
  environment?: EnvironmentMetadata;
  /** Extra non-identity headers to include on every request. */
  extraHeaders?: Record<string, string>;
  /**
   * Optional DPoP proof signer. When set, a `DPoP` header is attached to every
   * request carrying a freshly-minted proof JWT. The function receives the HTTP
   * method (`htm`) and the canonicalized target URL (`htu`) and must return the
   * signed compact-serialized DPoP proof JWT.
   *
   * When absent (default), no `DPoP` header is sent — existing unbound tokens
   * are unaffected (backward-compatible).
   */
  dpopSigner?: (htm: string, htu: string) => Promise<string>;
  /**
   * Custom transport. Defaults to the global `fetch`. Lets callers route
   * requests through an in-process handler (tests, benchmarks) without
   * patching globals. Called as a plain function, never bound to the client.
   */
  fetch?: typeof globalThis.fetch;
}

export class TilaClient {
  private baseUrl: string;
  private token: string | TokenProvider;
  private credentials?: CredentialManager;
  private validate: boolean;
  private timeoutMs: number;
  private extraHeaders: Record<string, string>;
  private dpopSigner?: (htm: string, htu: string) => Promise<string>;
  private fetchImpl?: typeof globalThis.fetch;
  readonly participantId: string;
  readonly environment: EnvironmentMetadata;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    const skew = opts.expirySkewMs ?? 30_000;
    if (!Number.isFinite(skew) || skew < 0)
      throw new TokenProviderError(
        "invalid-options",
        "expirySkewMs must be finite and nonnegative",
      );
    if (typeof opts.token === "function") {
      if (opts.dpopSigner)
        throw new TokenProviderError(
          "invalid-options",
          "Provider credentials must supply their own DPoP binding",
        );
      this.credentials = new CredentialManager(opts.token, skew);
    }
    this.validate = opts.validate ?? false;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.participantId = ParticipantIdSchema.parse(
      opts.participantId ?? crypto.randomUUID(),
    );
    this.environment = EnvironmentMetadataSchema.parse({
      ...opts.environment,
      client_name: opts.environment?.client_name ?? "sdk",
      client_version: opts.environment?.client_version ?? SDK_VERSION,
    });
    this.extraHeaders = {
      ...opts.extraHeaders,
      "X-Tila-Source": `${this.environment.client_name}/${this.environment.client_version}`,
      "X-Tila-Participant-Id": this.participantId,
      ...(this.environment.machine
        ? { "X-Tila-Machine": this.environment.machine }
        : {}),
      ...(this.environment.repository
        ? { "X-Tila-Repository": this.environment.repository }
        : {}),
      ...(this.environment.worktree
        ? { "X-Tila-Worktree": this.environment.worktree }
        : {}),
      ...(this.environment.branch
        ? { "X-Tila-Branch": this.environment.branch }
        : {}),
      ...(this.environment.commit
        ? { "X-Tila-Commit": this.environment.commit }
        : {}),
    };
    this.dpopSigner = opts.dpopSigner;
    this.fetchImpl = opts.fetch;
  }

  static fromConfig(
    config: TilaProjectConfig,
    token: string | TokenProvider,
    opts?: Pick<
      ClientOptions,
      | "extraHeaders"
      | "participantId"
      | "environment"
      | "timeoutMs"
      | "expirySkewMs"
      | "dpopSigner"
    >,
  ): TilaClient {
    if (config.backend === "local") {
      throw new Error(
        "Cannot create an HTTP TilaClient for a local backend (backend = " +
          '"local"). The local backend runs in-process on SQLite — use ' +
          "createTila(config) (which routes to the in-process backend) or " +
          "import createTilaLocal from 'tila-sdk/local' directly.",
      );
    }
    if (!config.worker_url) {
      throw new Error(
        "Cannot create TilaClient: config has no worker_url. " +
          "Use 'tila project create' or set backend = \"cloudflare\" in .tila/config.toml.",
      );
    }
    return new TilaClient({
      baseUrl: config.worker_url,
      token,
      // Optional caller attribution (e.g. mcp-server/<version>). When omitted,
      // the constructor's default X-Tila-Source (sdk/<version>) applies.
      ...(opts?.extraHeaders ? { extraHeaders: opts.extraHeaders } : {}),
      ...(opts?.participantId ? { participantId: opts.participantId } : {}),
      ...(opts?.environment ? { environment: opts.environment } : {}),
      timeoutMs: opts?.timeoutMs,
      expirySkewMs: opts?.expirySkewMs,
      dpopSigner: opts?.dpopSigner,
    });
  }

  private async transport<T>(
    method: string,
    path: string,
    opts: RequestOptions<T> | undefined,
    body: BodyInit | undefined,
    format: "json" | "multipart" | "raw",
  ): Promise<T | Response> {
    const url = new URL(path, `${this.baseUrl}/`);
    if (this.credentials && url.origin !== new URL(this.baseUrl).origin) {
      throw new TokenProviderError(
        "credential-origin-mismatch",
        "Provider credentials cannot be sent to another deployment",
      );
    }
    if (opts?.query)
      for (const [key, value] of Object.entries(opts.query)) {
        if (value !== undefined) url.searchParams.set(key, value);
      }
    const controller = new AbortController();
    const signal = controller.signal;
    const timeoutError = () =>
      new DOMException(
        `Request to ${url.origin} timed out after ${this.timeoutMs}ms`,
        "TimeoutError",
      );
    const cancel = () => controller.abort(opts?.signal?.reason);
    if (opts?.signal?.aborted) cancel();
    else opts?.signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(
      () => controller.abort(timeoutError()),
      this.timeoutMs,
    );
    try {
      signal.throwIfAborted();
      const context = {
        method: method.toUpperCase(),
        url: url.toString(),
        signal,
      };
      let generation = await this.credentials?.acquire(context);
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        const credential: TokenCredential = generation?.credential ?? {
          token: this.token as string,
        };
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(this.extraHeaders)) {
          if (!["authorization", "dpop"].includes(key.toLowerCase()))
            headers[key] = value;
        }
        headers.Authorization = `Bearer ${credential.token}`;
        if (format !== "raw") headers.Accept = "application/json";
        if (format === "json" && body !== undefined)
          headers["Content-Type"] = "application/json";
        if (opts?.idempotencyKey)
          headers["Idempotency-Key"] = opts.idempotencyKey;
        const htu = canonicalizeHtu(url.toString());
        if (credential.dpop) {
          const ath = await abortable(
            accessTokenHash(credential.token),
            signal,
          );
          headers.DPoP = await providerProof(credential.dpop, {
            htm: context.method,
            htu,
            accessToken: credential.token,
            ath,
            signal,
          });
        } else if (this.dpopSigner) {
          const signer = this.dpopSigner;
          headers.DPoP = await abortable(
            Promise.resolve().then(() => signer(context.method, htu)),
            signal,
          );
        }
        signal.throwIfAborted();
        let response: Response;
        try {
          // Resolve the global lazily so test-time `vi.stubGlobal("fetch")`
          // still intercepts clients constructed before the stub.
          const doFetch = this.fetchImpl ?? globalThis.fetch;
          response = await abortable(
            doFetch(url.toString(), {
              method: context.method,
              headers,
              body,
              signal,
              redirect: "error",
            }),
            signal,
          );
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          if (
            error instanceof Error &&
            ["AbortError", "TimeoutError"].includes(error.name)
          )
            throw timeoutError();
          throw new Error(`Network error connecting to ${url.origin}`, {
            cause: error,
          });
        }
        if (!response.ok) {
          const error = await abortable(readApiError(response), signal);
          if (
            attempt === 0 &&
            this.credentials &&
            generation &&
            error.status === 401 &&
            (error.code === "unauthorized" || error.code === "session-expired")
          ) {
            generation = await this.credentials.acquire(
              context,
              generation,
              error,
            );
            continue;
          }
          throw error;
        }
        if (format === "raw") return response;
        const result = await abortable(response.json(), signal);
        if ((opts?.validate ?? this.validate) && opts?.schema) {
          const parsed = opts.schema.safeParse(result);
          if (!parsed.success) {
            const issues = parsed.error.issues
              .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
              .join("\n");
            throw new Error(
              `Unexpected response shape from ${method} ${path}:\n${issues}`,
            );
          }
          return parsed.data;
        }
        return result as T;
      }
    } finally {
      clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", cancel);
    }
  }

  async request<T>(
    method: string,
    path: string,
    opts?: RequestOptions<T> & { body?: unknown },
  ): Promise<T> {
    return this.transport(
      method,
      path,
      opts,
      opts?.body === undefined ? undefined : JSON.stringify(opts.body),
      "json",
    ) as Promise<T>;
  }

  async get<T>(path: string, opts?: RequestOptions<T>): Promise<T> {
    return this.request("GET", path, opts);
  }

  async post<T>(
    path: string,
    body: unknown,
    opts?: RequestOptions<T>,
  ): Promise<T> {
    return this.request("POST", path, { ...opts, body });
  }

  async put<T>(
    path: string,
    body: unknown,
    opts?: RequestOptions<T>,
  ): Promise<T> {
    return this.request("PUT", path, { ...opts, body });
  }

  async patch<T>(
    path: string,
    body: unknown,
    opts?: RequestOptions<T>,
  ): Promise<T> {
    return this.request("PATCH", path, { ...opts, body });
  }

  async delete<T>(path: string, opts?: RequestOptions<T>): Promise<T> {
    return this.request("DELETE", path, opts);
  }

  async requestRaw(
    method: string,
    path: string,
    opts?: RequestOptions<never>,
  ): Promise<Response> {
    return this.transport(
      method,
      path,
      opts,
      undefined,
      "raw",
    ) as Promise<Response>;
  }

  async postFormData<T>(
    path: string,
    formData: FormData,
    opts?: RequestOptions<T>,
  ): Promise<T> {
    return this.transport(
      "POST",
      path,
      opts,
      formData,
      "multipart",
    ) as Promise<T>;
  }
}

export interface RequestOptions<T = unknown> {
  signal?: AbortSignal;
  idempotencyKey?: string;
  query?: Record<string, string | undefined>;
  schema?: z.ZodType<T, z.ZodTypeDef, unknown>;
  validate?: boolean;
}

export async function exchangeGitHubToken(
  baseUrl: string,
  projectId: string,
  githubToken: string,
): Promise<{ sessionToken: string; expiresAt: number; permission: string }> {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/auth/github/exchange`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: projectId,
        github_token: githubToken,
      }),
      // Bound the exchange so a hung/slow response can't block the caller (CLI,
      // MCP server) until the OS TCP timeout. 30s matches the TilaClient default
      // timeout (see ClientOptions.timeoutMs). AbortSignal.timeout is supported
      // in all of the SDK's target runtimes (Node 18.8+, Bun, Cloudflare Workers,
      // browsers).
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(
      `Network error during GitHub token exchange: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    try {
      const body = await res.json();
      const parsed = ErrorEnvelopeSchema.safeParse(body);
      if (parsed.success) {
        const { code, message, retryable } = parsed.data.error;
        throw new TilaApiError(
          res.status,
          toTilaErrorCode(code),
          message,
          retryable,
        );
      }
    } catch (err) {
      if (err instanceof TilaApiError) throw err;
    }
    throw new TilaApiError(
      res.status,
      "UNKNOWN",
      `HTTP ${res.status}: ${res.statusText}`,
      false,
    );
  }

  const body = await res.json();
  if (!body.session_token || typeof body.expires_at !== "number") {
    throw new TypeError(
      "Exchange returned unexpected response shape: missing session_token or expires_at",
    );
  }
  return {
    sessionToken: body.session_token,
    expiresAt: body.expires_at,
    permission: body.permission ?? "read",
  };
}

// ---------------------------------------------------------------------------
// createTila — uniform resource-method facade over local + HTTP backends
// ---------------------------------------------------------------------------

/**
 * The HTTP resource-method surface. Built from the zod-only factories
 * (`createTaskMethods`, `createRecordMethods`, …) so the type is derived from a
 * single source of truth and never drifts from the factory signatures.
 *
 * The LOCAL branch's `buildLocalResources` (in `./local/resource-adapters`)
 * presents the SAME shape, so consumers swap backends without changing call
 * sites. `tokens.issue` etc. throw `LocalUnsupportedError` under the local
 * backend (HTTP-only — D1 global token store).
 */
export interface TilaFacade {
  agents: ReturnType<typeof createAgentMethods>;
  handoffs: ReturnType<typeof createHandoffMethods>;
  reentry: ReturnType<typeof createReentryMethod>;
  tasks: ReturnType<typeof createTaskMethods>;
  records: ReturnType<typeof createRecordMethods>;
  claims: ReturnType<typeof createClaimMethods>;
  artifacts: ReturnType<typeof createArtifactMethods>;
  gates: ReturnType<typeof createGateMethods>;
  signals: ReturnType<typeof createSignalMethods>;
  journal: ReturnType<typeof createJournalMethods>;
  presence: ReturnType<typeof createPresenceMethods>;
  schema: ReturnType<typeof createSchemaMethods>;
  summary: ReturnType<typeof createSummaryMethods>;
  search: ReturnType<typeof createSearchMethods>;
  templates: ReturnType<typeof createTemplateMethods>;
  tokens: ReturnType<typeof createTokenMethods>;
  serviceAccounts: ReturnType<typeof createServiceAccountMethods>;
  /** Index artifact operations (create, addEntry, listEntries). */
  indexes: ReturnType<typeof createIndexMethods>;
  /**
   * Release backend resources. No-op for the HTTP backend; closes the SQLite
   * connection for the local backend. Always safe (and idempotent) to call.
   */
  close: () => void;
}

/** Build the HTTP-backed facade from a configured `TilaClient`. */
function buildHttpFacade(client: TilaClient, projectId: string): TilaFacade {
  return {
    agents: createAgentMethods(client, projectId),
    tasks: createTaskMethods(client, projectId),
    records: createRecordMethods(client, projectId),
    claims: createClaimMethods(client, projectId),
    artifacts: createArtifactMethods(client, projectId),
    gates: createGateMethods(client, projectId),
    signals: createSignalMethods(client, projectId),
    journal: createJournalMethods(client, projectId),
    handoffs: createHandoffMethods(client, projectId),
    reentry: createReentryMethod(client, projectId),
    presence: createPresenceMethods(client, projectId),
    schema: createSchemaMethods(client, projectId),
    summary: createSummaryMethods(client, projectId),
    search: createSearchMethods(client, projectId),
    templates: createTemplateMethods(client, projectId),
    tokens: createTokenMethods(client),
    serviceAccounts: createServiceAccountMethods(client, projectId),
    indexes: createIndexMethods(client, projectId),
    close: () => {},
  };
}

/**
 * @internal Test helper — exposes the HTTP facade builder without going through
 * the full `createTila` entry point (which requires a valid config and token).
 * Used in unit tests to verify facade shape without mocking config parsing.
 */
export function buildHttpFacadeForTest(
  client: TilaClient,
  projectId: string,
): TilaFacade {
  return buildHttpFacade(client, projectId);
}

/**
 * Create a uniform tila facade over either the local (in-process SQLite) or the
 * Cloudflare (HTTP) backend, selected by `config.backend`. Both branches expose
 * the EXACT same resource-method surface ({@link TilaFacade}); a consumer can
 * swap backends without touching any call site.
 *
 * - `backend: "cloudflare"` (default) → constructs a {@link TilaClient} from
 *   `config.worker_url` + `token` and wires the zod-only HTTP factories.
 * - `backend: "local"` → DYNAMICALLY imports `tila-sdk/local`'s
 *   `createTilaLocal` (the better-sqlite3 + node:fs stack) and the local
 *   resource adapters, then presents them through the same facade.
 *
 * ## Entry / bundle hygiene
 *
 * `createTila` lives in the MAIN (zod-only) entry. Its local branch must NOT be
 * statically reachable from the main bundle — the heavy SQLite stack belongs to
 * `tila-sdk/local`. So the local branch uses dynamic `import()` (mirroring how
 * `createTilaLocal` itself dynamically imports the native driver). Nothing heavy
 * is statically imported here, keeping `dist/index.js` zod-only (enforced by
 * `__tests__/bundle-hygiene.test.ts`).
 *
 * @param token Required for the Cloudflare backend; ignored for local.
 * @param opts  Optional Cloudflare-backend tuning. `opts.extraHeaders` is
 *   forwarded to the underlying `TilaClient` (e.g. a caller-attribution
 *   `X-Tila-Source: mcp-server/<version>` header). Ignored for the local
 *   backend, which makes no HTTP requests. Additive/back-compat: existing
 *   `createTila(config, token)` callers are unaffected.
 */
export async function createTila(
  config: TilaProjectConfig,
  token?: string | TokenProvider,
  opts?: Pick<
    ClientOptions,
    | "extraHeaders"
    | "participantId"
    | "environment"
    | "timeoutMs"
    | "expirySkewMs"
    | "dpopSigner"
  >,
): Promise<TilaFacade> {
  if (config.backend === "local") {
    if (!config.local) {
      throw new Error(
        'createTila: backend = "local" requires a [local] config section ' +
          "with db_path and artifacts_path.",
      );
    }
    // Dynamic import keeps the heavy SQLite stack out of the zod-only main
    // bundle (see bundle-hygiene note above). The main tsup config marks
    // `./local/index` EXTERNAL and rewrites it to the sibling built entry
    // (`./local.js` / `./local.cjs`), so esbuild emits a literal runtime
    // `import()` in BOTH the ESM and CJS main bundles — never inlining the
    // native/SQLite stack. (ESM alone would code-split this, but CJS would
    // otherwise inline it; the external rewrite fixes both formats uniformly.)
    const { createTilaLocal, buildLocalResources } = await import(
      "./local/index"
    );

    const { project, artifacts, close } = await createTilaLocal({
      dbPath: config.local.db_path,
      artifactsPath: config.local.artifacts_path,
      org: config.local.org,
      project: config.project_id,
      identity: {
        principal_id: `local:${config.local.org ?? "local"}`,
        participant_id: ParticipantIdSchema.parse(
          opts?.participantId ?? crypto.randomUUID(),
        ),
        environment: EnvironmentMetadataSchema.parse({
          client_name: "sdk",
          client_version: SDK_VERSION,
          ...opts?.environment,
        }),
      },
    });

    const resources = buildLocalResources(project, artifacts);
    // No `as unknown as` cast: `buildLocalResources` is compile-time asserted to
    // be structurally assignable to `Omit<TilaFacade, "close">` (see the
    // `_assertLocalSurfaceMatchesFacade` contract in resource-adapters.ts), so
    // adding `close` yields a checked `TilaFacade`. Any adapter drift is now a
    // build error here, not a silent runtime divergence.
    return { ...resources, close };
  }

  // Cloudflare (HTTP) backend.
  if (token === undefined) {
    throw new Error(
      'createTila: the Cloudflare backend requires a token. Pass createTila(config, token), or set backend = "local".',
    );
  }
  const client = TilaClient.fromConfig(config, token, {
    extraHeaders: opts?.extraHeaders,
    participantId: opts?.participantId,
    environment: opts?.environment,
    timeoutMs: opts?.timeoutMs,
    expirySkewMs: opts?.expirySkewMs,
    dpopSigner: opts?.dpopSigner,
  });
  return buildHttpFacade(client, config.project_id);
}
