import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { type Server, createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeRunContextSchema } from "@tila/schemas";
import {
  type RuntimeContext,
  RuntimeContextSchema,
  type RuntimeCredentialResponse,
} from "@tila/schemas";
import {
  type DpopBinding,
  RuntimeClient,
  type TokenProvider,
  TokenProviderError,
  assertRuntimeContext,
} from "tila-sdk";
import { runtimeEndpointPolicy } from "./runtime-proof";

export interface RuntimeBrokerReference {
  socket: string;
  capability: string;
}
export interface RuntimeRunControl {
  renew(expectedTokenId: string): Promise<RuntimeCredentialResponse>;
  heartbeat(): Promise<{ lease_expires_at: number }>;
  close(): Promise<unknown>;
}

/** One instance holds exactly one run; no RPC can create or select a run. */
export class RuntimeBroker {
  private server?: Server;
  private directory?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;
  private stopped = false;
  private closing?: Promise<void>;
  private failures = 0;
  private previous?: { token: string; until: number };
  private readonly initial: RuntimeContext;
  private readonly capability = randomBytes(32).toString("base64url");
  private readonly renewAhead = 120 + Math.random() * 10;
  constructor(
    private deployment: string,
    private value: RuntimeCredentialResponse,
    private binding: DpopBinding,
    private control: RuntimeRunControl,
    private fetchImpl?: typeof fetch,
  ) {
    this.initial = value.context;
    assertRuntimeContext(value.context, { ...value.context, purpose: "run" });
  }
  get context() {
    return RuntimeRunContextSchema.parse(this.value.context);
  }
  private valid() {
    if (this.stopped)
      throw new TokenProviderError("run-closed", "Runtime access has stopped");
    try {
      assertRuntimeContext(this.value.context, this.initial);
    } catch (error) {
      this.stopped = true;
      throw error;
    }
  }
  private async validateRemote() {
    const client = new RuntimeClient(
      {
        baseUrl: this.deployment,
        token: async () => ({ token: this.value.token, dpop: this.binding }),
        participantId: this.context.participant_id,
        fetch: this.fetchImpl,
      },
      this.context.project_id,
    );
    try {
      const context = await client.context();
      assertRuntimeContext(context, this.initial);
      this.value = { ...this.value, context };
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "retryable" in error &&
        error.retryable === false
      )
        this.stopped = true;
      throw error;
    }
  }
  async tick() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.advance().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }
  private async advance() {
    this.valid();
    try {
      if (
        (this.context.expires_at ?? 0) - Date.now() / 1000 <=
        this.renewAhead
      ) {
        const next = await this.control.renew(this.context.token_id);
        assertRuntimeContext(next.context, this.initial);
        this.previous = { token: this.value.token, until: Date.now() + 60_000 };
        this.value = next;
      }
      const beat = await this.control.heartbeat();
      this.value = {
        ...this.value,
        context: { ...this.context, lease_expires_at: beat.lease_expires_at },
      };
      await this.validateRemote();
      this.failures = 0;
    } catch (error) {
      const transient =
        error instanceof TypeError ||
        (error instanceof Error && error.name === "TimeoutError") ||
        (error &&
          typeof error === "object" &&
          "retryable" in error &&
          error.retryable === true);
      this.failures++;
      if (!transient) this.stopped = true;
      throw error;
    }
  }
  private schedule() {
    if (this.stopped) return;
    const delay = this.failures
      ? Math.min(30_000, 1000 * 2 ** Math.min(this.failures, 5))
      : 60_000;
    this.timer = setTimeout(() => {
      void this.tick()
        .catch(() => {})
        .finally(() => this.schedule());
    }, delay);
    this.timer.unref();
  }
  async listen(): Promise<RuntimeBrokerReference> {
    await this.validateRemote();
    this.directory = await mkdtemp(join(tmpdir(), "tila-run-"));
    await chmod(this.directory, 0o700);
    const socket = join(this.directory, "broker.sock");
    this.server = createServer(async (req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      try {
        const supplied = Buffer.from(
          req.headers.authorization?.replace(/^Bearer /, "") ?? "",
        );
        const expected = Buffer.from(this.capability);
        if (
          supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected)
        )
          throw new Error("runtime-capability-denied");
        this.valid();
        if (req.method === "GET" && req.url === "/context") {
          await this.validateRemote();
          res.end(
            JSON.stringify({
              context: this.context,
              deployment: this.deployment,
            }),
          );
          return;
        }
        if (req.method === "GET" && req.url === "/credential") {
          if (
            (this.context.expires_at ?? 0) - Date.now() / 1000 <=
            this.renewAhead
          )
            await this.tick();
          this.valid();
          res.end(
            JSON.stringify({
              token: this.value.token,
              context: this.context,
              jkt: this.binding.jkt,
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/proof") {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 16_384) throw new Error("runtime-request-too-large");
            chunks.push(chunk);
          }
          const data = JSON.parse(Buffer.concat(chunks).toString()) as {
            htm: string;
            htu: string;
            accessToken: string;
            ath: string;
          };
          if (
            data.accessToken !== this.value.token &&
            !(
              this.previous &&
              this.previous.until > Date.now() &&
              data.accessToken === this.previous.token
            )
          )
            throw new Error("runtime-binding-mismatch");
          const proof = await this.binding.signProof({
            ...data,
            signal: new AbortController().signal,
          });
          res.end(JSON.stringify({ proof }));
          return;
        }
        throw new Error("runtime-endpoint-denied");
      } catch (error) {
        res.statusCode = 403;
        res.end(
          JSON.stringify({
            error: {
              code:
                error instanceof TokenProviderError
                  ? error.code
                  : "runtime-access-denied",
              message: "Run access is unavailable",
            },
          }),
        );
      }
    });
    this.server.requestTimeout = 10_000;
    const server = this.server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    await chmod(socket, 0o600);
    this.schedule();
    return { socket, capability: this.capability };
  }
  close() {
    this.closing ??= this.finish();
    return this.closing;
  }
  private async finish() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    // Existing renewal finishes before closure; closure overrides every version.
    await this.inFlight?.catch(() => {});
    this.stopped = true;
    try {
      await this.control.close();
    } finally {
      this.server?.closeAllConnections();
      const server = this.server;
      if (server)
        await new Promise<void>((resolve) => server.close(() => resolve()));
      if (this.directory)
        await rm(this.directory, { recursive: true, force: true });
    }
  }
}

export function brokerReference(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeBrokerReference {
  const socket = env.TILA_RUN_SOCKET;
  const capability = env.TILA_RUN_CAPABILITY;
  if (!socket || !capability)
    throw new TokenProviderError(
      "runtime-auth-required",
      "Start this client with tila run exec or configure an enrolled session integration",
    );
  return { socket, capability };
}
export function brokerRpc<T>(
  reference: RuntimeBrokerReference,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: reference.socket,
        path,
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${reference.capability}`,
          "Content-Type": "application/json",
        },
        signal,
        timeout: 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > 65_536) req.destroy(new Error("Invalid broker response"));
          else chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString());
            if (res.statusCode !== 200)
              reject(
                new TokenProviderError(
                  value.error?.code ?? "runtime-access-denied",
                  "Run broker denied access",
                ),
              );
            else resolve(value);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Runtime broker timed out")));
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
export async function connectRuntimeBroker(reference: RuntimeBrokerReference) {
  const { context: raw, deployment } = await brokerRpc<{
    context: unknown;
    deployment: string;
  }>(reference, "/context");
  const initial = RuntimeContextSchema.parse(raw);
  assertRuntimeContext(initial, { ...initial, purpose: "run" });
  const permits = runtimeEndpointPolicy(initial.project_id, "run");
  const provider: TokenProvider = async (request) => {
    const url = new URL(request.url);
    if (
      url.origin !== new URL(deployment).origin ||
      !permits(url.pathname, request.method)
    )
      throw new TokenProviderError(
        "runtime-binding-mismatch",
        "Managed command cannot change deployment or project",
      );
    const value = await brokerRpc<{
      token: string;
      context: RuntimeContext;
      jkt: string;
    }>(reference, "/credential", undefined, request.signal);
    assertRuntimeContext(value.context, initial);
    if (request.previousCredential?.token !== value.token) {
      const fresh = await brokerRpc<{ context: RuntimeContext }>(
        reference,
        "/context",
        undefined,
        request.signal,
      );
      assertRuntimeContext(fresh.context, initial);
    }
    return {
      token: value.token,
      expiresAt: Math.min(
        RuntimeRunContextSchema.parse(value.context).expires_at,
        RuntimeRunContextSchema.parse(value.context).lease_expires_at,
      ),
      dpop: {
        jkt: value.jkt,
        signProof: async (proof) =>
          (
            await brokerRpc<{ proof: string }>(
              reference,
              "/proof",
              {
                htm: proof.htm,
                htu: proof.htu,
                accessToken: proof.accessToken,
                ath: proof.ath,
              },
              proof.signal,
            )
          ).proof,
      },
    };
  };
  return {
    context: RuntimeRunContextSchema.parse(initial),
    deployment,
    provider,
  };
}
