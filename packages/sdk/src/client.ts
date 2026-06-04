import { createRequire } from "node:module";
import { ErrorEnvelopeSchema, type TilaProjectConfig } from "@tila/schemas";
import type { z } from "zod";

const require = createRequire(import.meta.url);
const SDK_VERSION: string = (require("../package.json") as { version: string })
  .version;

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

  static fromConfig(config: TilaProjectConfig, token: string): TilaClient {
    if (!config.worker_url) {
      throw new Error(
        "Cannot create TilaClient: config has no worker_url. " +
          "Use 'tila project create' or set backend = \"cloudflare\" in .tila/config.toml.",
      );
    }
    return new TilaClient({ baseUrl: config.worker_url, token });
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
        throw new TilaApiError(res.status, code, message, retryable);
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
    public code: string,
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
        throw new TilaApiError(res.status, code, message, retryable);
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
