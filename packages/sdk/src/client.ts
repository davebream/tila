import { ErrorEnvelopeSchema, type TilaProjectConfig } from "@tila/schemas";
import type { z } from "zod";
import { createArtifactMethods } from "./artifacts";
import { createClaimMethods } from "./claims";
import { createTaskMethods } from "./entities";
import { type TilaErrorCode, toTilaErrorCode } from "./error-codes";
import { createGateMethods } from "./gates";
import { createJournalMethods } from "./journal";
import { createPresenceMethods } from "./presence";
import { createRecordMethods } from "./records";
import { createSchemaMethods } from "./schema";
import { createSearchMethods } from "./search";
import { createSignalMethods } from "./signals";
import { createSummaryMethods } from "./summary";
import { createTemplateMethods } from "./templates";
import { createTokenMethods } from "./tokens";
import { SDK_VERSION } from "./version";

export interface ClientOptions {
  baseUrl: string;
  token: string;
  validate?: boolean;
  /** Request timeout in milliseconds. Default: 30000 (30s). */
  timeoutMs?: number;
  /** Extra headers to include on every request. Overrides the default X-Tila-Source header if provided. */
  extraHeaders?: Record<string, string>;
}

export class TilaClient {
  private baseUrl: string;
  private token: string;
  private validate: boolean;
  private timeoutMs: number;
  private extraHeaders: Record<string, string>;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.validate = opts.validate ?? false;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.extraHeaders = {
      "X-Tila-Source": `sdk/${SDK_VERSION}`,
      ...opts.extraHeaders,
    };
  }

  /**
   * Creates an AbortSignal that fires after this.timeoutMs.
   * Uses AbortSignal.timeout() when available (Node 18.8+, Bun 0.5+, browsers),
   * falls back to manual setTimeout + AbortController for older runtimes.
   *
   * Note: Cloudflare Workers has supported AbortSignal.timeout() since 2023;
   * the fallback branch will never execute there.
   */
  private createAbortSignal(): AbortSignal {
    if (typeof AbortSignal.timeout === "function") {
      return AbortSignal.timeout(this.timeoutMs);
    }
    const controller = new AbortController();
    setTimeout(
      () =>
        controller.abort(
          new DOMException(
            "The operation was aborted due to timeout",
            "TimeoutError",
          ),
        ),
      this.timeoutMs,
    );
    return controller.signal;
  }

  static fromConfig(
    config: TilaProjectConfig,
    token: string,
    opts?: { extraHeaders?: Record<string, string> },
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
    });
  }

  async request<T>(
    method: string,
    path: string,
    opts?: {
      body?: unknown;
      query?: Record<string, string | undefined>;
      schema?: z.ZodType<T>;
      validate?: boolean;
    },
  ): Promise<T> {
    const url = new URL(path, `${this.baseUrl}/`);
    if (opts?.query) {
      for (const [key, value] of Object.entries(opts.query)) {
        if (value !== undefined) {
          url.searchParams.set(key, value);
        }
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
      ...this.extraHeaders,
    };

    const init: RequestInit = {
      method,
      headers,
      signal: this.createAbortSignal(),
    };
    if (opts?.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await fetch(url.toString(), init);
    } catch (err) {
      if (
        err instanceof Error &&
        (err.name === "AbortError" || err.name === "TimeoutError")
      ) {
        throw new Error(
          `Request to ${url.origin} timed out after ${this.timeoutMs}ms`,
        );
      }
      throw new Error(
        `Network error connecting to ${url.origin}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!res.ok) {
      await this.throwApiError(res);
    }

    const body = await res.json();
    const shouldValidate = opts?.validate ?? this.validate;
    if (shouldValidate && opts?.schema) {
      const result = opts.schema.safeParse(body);
      if (!result.success) {
        const issues = result.error.issues
          .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
          .join("\n");
        throw new Error(
          `Unexpected response shape from ${method} ${path}:\n${issues}`,
        );
      }
      return result.data;
    }
    return body as T;
  }

  async get<T>(
    path: string,
    opts?: {
      schema?: z.ZodType<T>;
      query?: Record<string, string | undefined>;
      validate?: boolean;
    },
  ): Promise<T> {
    return this.request("GET", path, {
      schema: opts?.schema,
      query: opts?.query,
      validate: opts?.validate,
    });
  }

  async post<T>(
    path: string,
    body: unknown,
    opts?: { schema?: z.ZodType<T>; validate?: boolean },
  ): Promise<T> {
    return this.request("POST", path, {
      body,
      schema: opts?.schema,
      validate: opts?.validate,
    });
  }

  async put<T>(
    path: string,
    body: unknown,
    opts?: { schema?: z.ZodType<T>; validate?: boolean },
  ): Promise<T> {
    return this.request("PUT", path, {
      body,
      schema: opts?.schema,
      validate: opts?.validate,
    });
  }

  async patch<T>(
    path: string,
    body: unknown,
    opts?: { schema?: z.ZodType<T>; validate?: boolean },
  ): Promise<T> {
    return this.request("PATCH", path, {
      body,
      schema: opts?.schema,
      validate: opts?.validate,
    });
  }

  async delete<T>(
    path: string,
    opts?: { schema?: z.ZodType<T>; validate?: boolean },
  ): Promise<T> {
    return this.request("DELETE", path, {
      schema: opts?.schema,
      validate: opts?.validate,
    });
  }

  async requestRaw(
    method: string,
    path: string,
    opts?: { query?: Record<string, string | undefined> },
  ): Promise<Response> {
    const url = new URL(path, `${this.baseUrl}/`);
    if (opts?.query) {
      for (const [key, value] of Object.entries(opts.query)) {
        if (value !== undefined) {
          url.searchParams.set(key, value);
        }
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      ...this.extraHeaders,
    };

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method,
        headers,
        signal: this.createAbortSignal(),
      });
    } catch (err) {
      if (
        err instanceof Error &&
        (err.name === "AbortError" || err.name === "TimeoutError")
      ) {
        throw new Error(
          `Request to ${url.origin} timed out after ${this.timeoutMs}ms`,
        );
      }
      throw new Error(
        `Network error connecting to ${url.origin}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!res.ok) {
      await this.throwApiError(res);
    }

    return res;
  }

  async postFormData<T>(
    path: string,
    formData: FormData,
    opts?: { schema?: z.ZodType<T>; validate?: boolean },
  ): Promise<T> {
    const url = new URL(path, `${this.baseUrl}/`);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
      ...this.extraHeaders,
    };
    // Do NOT set Content-Type — fetch sets it with the boundary automatically for FormData

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method: "POST",
        headers,
        body: formData,
        signal: this.createAbortSignal(),
      });
    } catch (err) {
      if (
        err instanceof Error &&
        (err.name === "AbortError" || err.name === "TimeoutError")
      ) {
        throw new Error(
          `Request to ${url.origin} timed out after ${this.timeoutMs}ms`,
        );
      }
      throw new Error(
        `Network error connecting to ${url.origin}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!res.ok) {
      await this.throwApiError(res);
    }

    const body = await res.json();
    const shouldValidate = opts?.validate ?? this.validate;
    if (shouldValidate && opts?.schema) {
      const result = opts.schema.safeParse(body);
      if (!result.success) {
        const issues = result.error.issues
          .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
          .join("\n");
        throw new Error(
          `Unexpected response shape from POST ${path}:\n${issues}`,
        );
      }
      return result.data;
    }
    return body as T;
  }

  private async throwApiError(res: Response): Promise<never> {
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
}

export class TilaApiError extends Error {
  constructor(
    public status: number,
    public code: TilaErrorCode,
    message: string,
    public retryable: boolean,
  ) {
    super(message);
    this.name = "TilaApiError";
  }
}

export function isTilaApiError(err: unknown): err is TilaApiError {
  return err instanceof TilaApiError;
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
  /**
   * Release backend resources. No-op for the HTTP backend; closes the SQLite
   * connection for the local backend. Always safe (and idempotent) to call.
   */
  close: () => void;
}

/** Build the HTTP-backed facade from a configured `TilaClient`. */
function buildHttpFacade(client: TilaClient, projectId: string): TilaFacade {
  return {
    tasks: createTaskMethods(client, projectId),
    records: createRecordMethods(client, projectId),
    claims: createClaimMethods(client, projectId),
    artifacts: createArtifactMethods(client, projectId),
    gates: createGateMethods(client, projectId),
    signals: createSignalMethods(client, projectId),
    journal: createJournalMethods(client, projectId),
    presence: createPresenceMethods(client, projectId),
    schema: createSchemaMethods(client, projectId),
    summary: createSummaryMethods(client, projectId),
    search: createSearchMethods(client, projectId),
    templates: createTemplateMethods(client, projectId),
    tokens: createTokenMethods(client),
    close: () => {},
  };
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
  token?: string,
  opts?: { extraHeaders?: Record<string, string> },
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
  });
  return buildHttpFacade(client, config.project_id);
}
