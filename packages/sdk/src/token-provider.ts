import {
  OidcExchangeRequestSchema,
  OidcExchangeResponseSchema,
} from "@tila/schemas";
import { abortable } from "./abort";
import { type TilaApiError, readApiError } from "./errors";

export interface DpopProofContext {
  htm: string;
  htu: string;
  accessToken: string;
  ath: string;
  signal: AbortSignal;
}

export interface DpopBinding {
  jkt: string;
  /** Return a fresh ES256 proof with the supplied htm, htu and ath claims. */
  signProof(context: DpopProofContext): Promise<string>;
}

export interface TokenCredential {
  token: string;
  tokenType?: "Bearer";
  /** Unix seconds. Omit when expiry is unknown. */
  expiresAt?: number;
  dpop?: DpopBinding;
  /** Application-owned state; never persisted or logged by the SDK. */
  refreshMetadata?: unknown;
}

export interface TokenProviderContext {
  method: string;
  url: string;
  signal: AbortSignal;
  reason: "initial" | "expiry" | "request" | "authentication";
  previousCredential?: TokenCredential;
  authenticationError?: TilaApiError;
}

export type TokenProvider = (
  context: TokenProviderContext,
) => Promise<TokenCredential>;

export class TokenProviderError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TokenProviderError";
  }
}

export function validateCredential(value: TokenCredential): TokenCredential {
  if (
    !value ||
    typeof value.token !== "string" ||
    !/^[\x21-\x7e]+$/.test(value.token) ||
    (value.tokenType !== undefined && value.tokenType !== "Bearer") ||
    (value.expiresAt !== undefined &&
      (!Number.isFinite(value.expiresAt) ||
        value.expiresAt <= Date.now() / 1000)) ||
    (value.dpop !== undefined &&
      (!value.dpop ||
        typeof value.dpop !== "object" ||
        !/^[A-Za-z0-9_-]{43}$/.test(value.dpop.jkt) ||
        typeof value.dpop.signProof !== "function"))
  ) {
    throw new TokenProviderError(
      "invalid-credential",
      "Provider returned an invalid or expired credential",
    );
  }
  return { ...value, ...(value.dpop ? { dpop: { ...value.dpop } } : {}) };
}

export function createServiceTokenProvider(
  source: string | TokenCredential | TokenProvider,
): TokenProvider {
  return typeof source === "function"
    ? source
    : async () => (typeof source === "string" ? { token: source } : source);
}

export function createExternalTokenProvider(
  load: TokenProvider,
): TokenProvider {
  return load;
}

export interface OidcWorkloadTokenProviderOptions {
  baseUrl: string;
  projectId: string;
  /** Must obtain a fresh assertion each time; the server consumes it once. */
  getAssertion(context: TokenProviderContext): Promise<string>;
  dpop?: DpopBinding;
}

export function createOidcWorkloadTokenProvider(
  options: OidcWorkloadTokenProviderOptions,
): TokenProvider {
  const endpoint = new URL("/api/auth/oidc/exchange", options.baseUrl);
  return async (context) => {
    context.signal.throwIfAborted();
    if (new URL(context.url).origin !== endpoint.origin) {
      throw new TokenProviderError(
        "credential-origin-mismatch",
        "Workload credential belongs to another deployment",
      );
    }
    const assertion = await abortable(
      Promise.resolve().then(() => options.getAssertion(context)),
      context.signal,
    );
    const request = OidcExchangeRequestSchema.safeParse({
      project_id: options.projectId,
      oidc_token: assertion,
      jkt: options.dpop?.jkt,
    });
    if (!request.success)
      throw new TokenProviderError(
        "invalid-assertion",
        "Invalid workload assertion or binding",
      );
    context.signal.throwIfAborted();
    let response: Response;
    try {
      response = await abortable(
        fetch(endpoint.toString(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(request.data),
          signal: context.signal,
          redirect: "error",
        }),
        context.signal,
      );
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason;
      throw new TokenProviderError(
        "exchange-network-error",
        "Workload credential exchange failed",
        false,
        { cause: error },
      );
    }
    if (!response.ok)
      throw await abortable(readApiError(response), context.signal);
    let body: unknown;
    try {
      body = await abortable(response.json(), context.signal);
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason;
      throw new TokenProviderError(
        "invalid-exchange-response",
        "Invalid workload exchange response",
      );
    }
    const parsed = OidcExchangeResponseSchema.safeParse(body);
    if (
      !parsed.success ||
      parsed.data.project_id !== options.projectId ||
      !parsed.data.principal_id?.startsWith("service:") ||
      !parsed.data.credential_id ||
      !parsed.data.token_id
    ) {
      throw new TokenProviderError(
        "invalid-exchange-response",
        "Exchange did not return a scoped service credential",
      );
    }
    return validateCredential({
      token: parsed.data.session_token,
      tokenType: "Bearer",
      expiresAt: parsed.data.expires_at,
      dpop: options.dpop,
    });
  };
}

type Generation = {
  credential: TokenCredential;
  id: number;
  authenticationRefresh: boolean;
};
type Acquisition = {
  controller: AbortController;
  promise: Promise<Generation>;
  waiters: number;
};

/** One coordinator per client: no global or cross-customer credential cache. */
export class CredentialManager {
  private current?: Generation;
  private invalidated?: Generation;
  private pending?: Acquisition;
  private nextId = 0;

  constructor(
    private provider: TokenProvider,
    private skewMs: number,
  ) {}

  async acquire(
    context: Pick<TokenProviderContext, "method" | "url" | "signal">,
    rejected?: Generation,
    authenticationError?: TilaApiError,
  ): Promise<Generation> {
    context.signal.throwIfAborted();
    if (
      rejected &&
      this.current &&
      (this.current.id === rejected.id ||
        (this.current.credential.token === rejected.credential.token &&
          !this.current.authenticationRefresh))
    ) {
      this.invalidated = this.current;
      this.current = undefined;
    }
    if (
      this.current &&
      ((rejected &&
        this.current.id > rejected.id &&
        (this.current.credential.expiresAt === undefined ||
          this.current.credential.expiresAt * 1000 > Date.now())) ||
        (this.current.credential.expiresAt !== undefined &&
          this.current.credential.expiresAt * 1000 - this.skewMs > Date.now()))
    ) {
      return this.current;
    }
    if (!this.pending) {
      const previous = this.current ?? this.invalidated ?? rejected;
      const controller = new AbortController();
      const acquisition: Acquisition = {
        controller,
        waiters: 0,
        promise: Promise.resolve()
          .then(async () => {
            controller.signal.throwIfAborted();
            const credential = validateCredential(
              await this.provider({
                ...context,
                signal: controller.signal,
                previousCredential: previous?.credential,
                authenticationError,
                reason: rejected
                  ? "authentication"
                  : !previous
                    ? "initial"
                    : previous.credential.expiresAt === undefined
                      ? "request"
                      : "expiry",
              }),
            );
            controller.signal.throwIfAborted();
            const generation = {
              credential,
              id: ++this.nextId,
              authenticationRefresh: rejected !== undefined,
            };
            if (this.pending === acquisition) {
              this.current = generation;
              this.invalidated = undefined;
            }
            return generation;
          })
          .finally(() => {
            if (this.pending === acquisition) this.pending = undefined;
          }),
      };
      this.pending = acquisition;
    }
    const acquisition = this.pending;
    acquisition.waiters++;
    try {
      const result = await abortable(acquisition.promise, context.signal);
      // An ordinary load may already be running when a 401 arrives. If it
      // returns the rejected token, the provider still needs the auth context
      // to force refresh. Share that follow-up acquisition across all waiters.
      if (
        rejected &&
        !result.authenticationRefresh &&
        result.credential.token === rejected.credential.token
      ) {
        return this.acquire(context, result, authenticationError);
      }
      return result;
    } finally {
      acquisition.waiters--;
      if (acquisition.waiters === 0 && this.pending === acquisition) {
        this.pending = undefined;
        acquisition.controller.abort();
      }
    }
  }
}
