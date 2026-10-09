import {
  type CredentialPolicy,
  type RuntimeContext,
  RuntimeContextSchema,
  RuntimeCredentialResponseSchema,
  type RuntimeEnrollmentRequest,
  RuntimeEnrollmentsResponseSchema,
  RuntimeInvitationResponseSchema,
  RuntimeRunCredentialResponseSchema,
  type RuntimeRunRequest,
  RuntimeRunsResponseSchema,
  accessTokenHash,
  canonicalizeHtu,
  policyContains,
} from "@tila/schemas";
import { type ClientOptions, TilaClient } from "./client";
import { readApiError } from "./errors";
import { type DpopBinding, TokenProviderError } from "./token-provider";

/** Fresh assertion exchange for a fixed run and proof key, never operator auth. */
export async function exchangeRuntimeWorkload(options: {
  baseUrl: string;
  projectId: string;
  operationId: string;
  assertion: string;
  binding: DpopBinding;
  policy?: CredentialPolicy;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}) {
  const endpoint = new URL(
    "/api/auth/oidc/exchange",
    options.baseUrl,
  ).toString();
  const signal = options.signal ?? AbortSignal.timeout(30_000);
  const proof = await options.binding.signProof({
    htm: "POST",
    htu: canonicalizeHtu(endpoint),
    accessToken: options.assertion,
    ath: await accessTokenHash(options.assertion),
    signal,
  });
  const response = await (options.fetch ?? fetch)(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", DPoP: proof },
    redirect: "error",
    signal,
    body: JSON.stringify({
      project_id: options.projectId,
      oidc_token: options.assertion,
      jkt: options.binding.jkt,
      runtime: { operation_id: options.operationId, policy: options.policy },
    }),
  });
  if (!response.ok) throw await readApiError(response);
  return RuntimeRunCredentialResponseSchema.parse(await response.json());
}

/** Runtime control API. It deliberately does not infer credentials or projects. */
export class RuntimeClient {
  private client: TilaClient;
  private root: string;
  constructor(
    private options: ClientOptions,
    readonly projectId: string,
  ) {
    this.client = new TilaClient({ ...options, validate: true });
    this.root = `/projects/${encodeURIComponent(projectId)}/runtime`;
  }
  async context(signal?: AbortSignal) {
    try {
      return await this.client.get("/api/runtime/context", {
        schema: RuntimeContextSchema,
        signal,
      });
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "status" in error &&
        error.status === 404
      )
        throw new TokenProviderError(
          "runtime-server-incompatible",
          "Server must support runtime protocol 1; upgrade the backend to tila 0.4.0 or newer",
        );
      throw error;
    }
  }
  private installationClient(binding: DpopBinding, invitation?: string) {
    return new TilaClient({
      ...this.options,
      validate: true,
      ...(invitation ? { token: invitation } : {}),
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        const bearer =
          invitation ?? headers.get("Authorization")?.replace(/^Bearer /i, "");
        if (!bearer)
          throw new TokenProviderError(
            "runtime-auth-required",
            "Installation setup requires authentication",
          );
        const proof = await binding.signProof({
          htm: "POST",
          htu: canonicalizeHtu(String(url)),
          accessToken: bearer,
          ath: await accessTokenHash(bearer),
          signal: init?.signal ?? new AbortController().signal,
        });
        headers.set(invitation ? "DPoP" : "X-Tila-Enrollment-Proof", proof);
        return (this.options.fetch ?? globalThis.fetch)(url, {
          ...init,
          headers,
        });
      },
    });
  }
  enroll(
    input: RuntimeEnrollmentRequest,
    binding: DpopBinding,
    invitation?: string,
  ) {
    return this.installationClient(binding, invitation).post(
      `${this.root}/${invitation ? "redeem" : "enrollments"}`,
      { ...input, ...(invitation ? { invitation } : {}) },
      { schema: RuntimeCredentialResponseSchema },
    );
  }
  authorize(name: string, policy?: CredentialPolicy) {
    return this.client.post(
      `${this.root}/invitations`,
      { name, policy },
      { schema: RuntimeInvitationResponseSchema },
    );
  }
  enrollments() {
    return this.client.get(`${this.root}/enrollments`, {
      schema: RuntimeEnrollmentsResponseSchema,
    });
  }
  revokeEnrollment(id: string) {
    return this.client.post(
      `${this.root}/enrollments/${encodeURIComponent(id)}/revoke`,
      {},
    );
  }
  start(input: RuntimeRunRequest) {
    return this.client.post(`${this.root}/runs`, input, {
      schema: RuntimeRunCredentialResponseSchema,
    });
  }
  runs() {
    return this.client.get(`${this.root}/runs`, {
      schema: RuntimeRunsResponseSchema,
    });
  }
  renew(id: string, expectedTokenId: string) {
    return this.client.post(
      `${this.root}/runs/${encodeURIComponent(id)}/renew`,
      { expected_token_id: expectedTokenId },
      { schema: RuntimeRunCredentialResponseSchema },
    );
  }
  heartbeat(id: string) {
    return this.client.post<{ ok: true; lease_expires_at: number }>(
      `${this.root}/runs/${encodeURIComponent(id)}/heartbeat`,
      {},
    );
  }
  close(id: string) {
    return this.client.post(
      `${this.root}/runs/${encodeURIComponent(id)}/close`,
      {},
    );
  }
  revokeRun(id: string) {
    return this.client.post(
      `${this.root}/runs/${encodeURIComponent(id)}/revoke`,
      {},
    );
  }
}

/** Pins identity for a connection while allowing only authority reduction. */
export function assertRuntimeContext(
  context: RuntimeContext,
  expected: Pick<RuntimeContext, "instance_id" | "project_id" | "purpose"> &
    Partial<RuntimeContext>,
  now = Date.now() / 1000,
) {
  RuntimeContextSchema.parse(context);
  for (const key of [
    "instance_id",
    "project_id",
    "purpose",
    "enrollment_id",
    "workload_binding_id",
    "run_id",
    "participant_id",
    "principal_id",
  ] as const) {
    if (expected[key] !== undefined && context[key] !== expected[key])
      throw new TokenProviderError(
        "runtime-binding-mismatch",
        `Runtime ${key} changed`,
      );
  }
  if (expected.policy && !policyContains(expected.policy, context.policy))
    throw new TokenProviderError(
      "runtime-policy-denied",
      "Runtime authority exceeds its initial ceiling",
    );
  if (
    context.purpose === "run" &&
    (!context.run_id ||
      !context.participant_id ||
      !context.expires_at ||
      !context.lease_expires_at ||
      context.expires_at <= now ||
      context.lease_expires_at <= now)
  )
    throw new TokenProviderError(
      "run-expired",
      "Active run authentication is required",
    );
}
