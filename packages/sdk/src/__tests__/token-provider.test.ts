import { accessTokenHash } from "@tila/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TilaApiError, TilaClient, createTila } from "../client";
import { withRetry } from "../retry";
import {
  type DpopProofContext,
  type TokenCredential,
  type TokenProviderContext,
  TokenProviderError,
  createExternalTokenProvider,
  createOidcWorkloadTokenProvider,
  createServiceTokenProvider,
} from "../token-provider";

const baseUrl = "https://api.test";
const ok = () => new Response(JSON.stringify({ ok: true }));
const denied = (code = "unauthorized", status = 401) =>
  new Response(
    JSON.stringify({
      ok: false,
      error: { code, message: "Denied", retryable: false },
    }),
    { status },
  );
const future = () => Math.floor(Date.now() / 1000) + 300;
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Uninitialized");
  };
  let reject: (error: unknown) => void = () => {
    throw new Error("Uninitialized");
  };
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("credential coordinator", () => {
  it("does not reuse a newer but already expired token for a late 401", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const slow = deferred<Response>();
    let number = 0;
    const load = vi.fn(async () => ({
      token: `token-${++number}`,
      expiresAt: Date.now() / 1000 + 2,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (new Headers(init.headers).get("Authorization") === "Bearer token-1")
          return url.endsWith("/slow") ? slow.promise : denied();
        return ok();
      }),
    );
    const client = new TilaClient({ baseUrl, token: load });
    const late = client.get("/slow");
    await client.get("/fast");
    await vi.advanceTimersByTimeAsync(2000);
    slow.resolve(denied());
    await late;
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("supports providers through fromConfig and createTila, forwarding cache options", async () => {
    const config = {
      backend: "cloudflare" as const,
      worker_url: baseUrl,
      project_id: "project",
      schema_version: 1,
      tila_version: "0",
      created_at: "",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok()),
    );
    const load = vi.fn(async () => ({ token: "token", expiresAt: future() }));
    const client = TilaClient.fromConfig(config, load, {
      expirySkewMs: 600_000,
    });
    await client.get("/a");
    await client.get("/b");
    const tila = await createTila(config, load, { expirySkewMs: 600_000 });
    await tila.tasks.get("a");
    await tila.tasks.get("b");
    expect(load).toHaveBeenCalledTimes(4);
  });
  it("deduplicates concurrent acquisition and refresh at the exact skew boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const load = vi.fn(async () => ({
      token: "credential",
      expiresAt: future(),
    }));
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => ok());
    vi.stubGlobal("fetch", fetch);
    const client = new TilaClient({ baseUrl, token: load });
    await Promise.all(Array.from({ length: 12 }, () => client.get("/test")));
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(269999);
    await client.get("/test");
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([client.get("/a"), client.get("/b")]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("reacquires unknown-expiry credentials on later requests and isolates clients", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, _init: RequestInit) => ok()),
    );
    const load = vi.fn(async () => ({ token: "credential" }));
    const first = new TilaClient({ baseUrl, token: load });
    await Promise.all([first.get("/a"), first.get("/b")]);
    expect(load).toHaveBeenCalledTimes(1);
    await first.get("/c");
    await new TilaClient({ baseUrl, token: load }).get("/d");
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("uses short-lived credentials once without refresh loops", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, _init: RequestInit) => ok()),
    );
    const load = vi.fn(async () => ({
      token: "short",
      expiresAt: Date.now() / 1000 + 5,
    }));
    const client = new TilaClient({ baseUrl, token: load });
    await client.get("/a");
    await client.get("/b");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("deduplicates 401 refresh and does not invalidate a newer generation for a late 401", async () => {
    const slow = deferred<Response>();
    let number = 0;
    const load = vi.fn(async (_context: TokenProviderContext) => ({
      token: `token-${++number}`,
      expiresAt: future(),
      refreshMetadata: { generation: number },
    }));
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (new Headers(init.headers).get("Authorization") === "Bearer token-1")
        return url.endsWith("/slow") ? slow.promise : denied();
      return ok();
    });
    vi.stubGlobal("fetch", fetch);
    const client = new TilaClient({ baseUrl, token: load });
    const late = client.get("/slow");
    await Promise.all([client.get("/a"), client.get("/b")]);
    slow.resolve(denied());
    await late;
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls[1]?.[0]).toMatchObject({
      reason: "authentication",
      previousCredential: {
        token: "token-1",
        refreshMetadata: { generation: 1 },
      },
      authenticationError: { status: 401, code: "unauthorized" },
    });
  });

  it("preserves application error identity and recovers after a failed acquisition", async () => {
    const error = Object.assign(new Error("external-secret"), {
      code: "external-code",
    });
    const load = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue({ token: "working" });
    const log = vi.spyOn(console, "error");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, _init: RequestInit) => ok()),
    );
    const client = new TilaClient({ baseUrl, token: load });
    await expect(client.get("/test")).rejects.toBe(error);
    await client.get("/test");
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    { token: "" },
    { token: "secret\nheader" },
    { token: "secret", tokenType: "Basic" },
    { token: "secret", expiresAt: 0 },
    { token: "secret", expiresAt: Number.NaN },
  ])(
    "rejects invalid credentials without exposing their values",
    async (credential) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const client = new TilaClient({
        baseUrl,
        token: async () => credential as TokenCredential,
      });
      await expect(client.get("/test")).rejects.toMatchObject({
        code: "invalid-credential",
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

describe("request cancellation and deadlines", () => {
  it("cancels retry backoff with a custom reason and clears the timer", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const fn = vi.fn(async () => {
      throw new Error("temporary");
    });
    const request = withRetry(fn, {
      signal: abort.signal,
      baseDelayMs: 1000,
      jitter: false,
    });
    await flush();
    abort.abort("stop");
    await expect(request).rejects.toBe("stop");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels one waiter without cancelling another", async () => {
    const pending = deferred<TokenCredential>();
    const load = vi.fn((_: TokenProviderContext) => pending.promise);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, _init: RequestInit) => ok()),
    );
    const client = new TilaClient({ baseUrl, token: load });
    const abort = new AbortController();
    const first = client.get("/a", { signal: abort.signal });
    const second = client.get("/b");
    await flush();
    abort.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(load.mock.calls[0]?.[0].signal.aborted).toBe(false);
    pending.resolve({ token: "valid", expiresAt: future() });
    await second;
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("abandons all-cancelled acquisition and ignores its late result", async () => {
    const old = deferred<TokenCredential>();
    const load = vi
      .fn((_: TokenProviderContext) => old.promise)
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValue({ token: "new", expiresAt: future() });
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => ok());
    vi.stubGlobal("fetch", fetch);
    const client = new TilaClient({ baseUrl, token: load });
    const abort = new AbortController();
    const request = client.get("/a", { signal: abort.signal });
    await flush();
    abort.abort("cancelled");
    await expect(request).rejects.toBe("cancelled");
    expect(load.mock.calls[0]?.[0].signal.aborted).toBe(true);
    await client.get("/b");
    old.resolve({ token: "old", expiresAt: future() });
    await flush();
    await client.get("/c");
    expect(
      fetch.mock.calls.every(
        (call) =>
          new Headers((call[1] as RequestInit).headers).get("Authorization") ===
          "Bearer new",
      ),
    ).toBe(true);
  });

  it("does not acquire or fetch with an already cancelled signal", async () => {
    const load = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = new TilaClient({ baseUrl, token: load });
    await expect(
      client.get("/a", { signal: AbortSignal.abort("stop") }),
    ).rejects.toBe("stop");
    expect(load).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["provider", "signer", "body"])(
    "times out a hung %s even when it ignores cancellation",
    async (stage) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_800_000_000_000);
      const forever = new Promise<never>(() => {});
      const fetch = vi.fn(async () => ({ ok: true, json: () => forever }));
      vi.stubGlobal("fetch", fetch);
      const client = new TilaClient({
        baseUrl,
        timeoutMs: 50,
        token: stage === "provider" ? () => forever : "static",
        ...(stage === "signer" ? { dpopSigner: () => forever } : {}),
      });
      const result = expect(client.get("/a")).rejects.toMatchObject({
        name: "TimeoutError",
      });
      await vi.advanceTimersByTimeAsync(50);
      await result;
      if (stage !== "body") expect(fetch).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("keeps one deadline across credential acquisition and auth retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const load = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { token: "token", expiresAt: future() };
    });
    const fetch = vi.fn(async () => denied());
    vi.stubGlobal("fetch", fetch);
    const client = new TilaClient({ baseUrl, timeoutMs: 50, token: load });
    const result = expect(client.get("/a")).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(50);
    await result;
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("transport authentication", () => {
  it("does not refresh after network failures or send provider tokens across origins", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("network");
    });
    vi.stubGlobal("fetch", fetch);
    const load = vi.fn(async () => ({ token: "token" }));
    const client = new TilaClient({ baseUrl, token: load });
    await expect(client.get("/a")).rejects.toThrow("Network error");
    expect(load).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(client.get("https://other.test/a")).rejects.toMatchObject({
      code: "credential-origin-mismatch",
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an unbound provider proof before sending any request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = new TilaClient({
      baseUrl,
      token: async () => ({
        token: "token",
        dpop: {
          jkt: "a".repeat(43),
          signProof: async () => "invalid.proof.signature",
        },
      }),
    });
    await expect(client.get("/a")).rejects.toMatchObject({
      code: "invalid-dpop-proof",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["json", "raw", "multipart"])(
    "retries %s once with the same request identity",
    async (format) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(denied("session-expired"))
        .mockResolvedValueOnce(ok());
      vi.stubGlobal("fetch", fetch);
      let number = 0;
      const client = new TilaClient({
        baseUrl,
        token: async () => ({ token: `token-${++number}` }),
        extraHeaders: { authorization: "wrong", DPOP: "wrong" },
      });
      const opts = { idempotencyKey: "same-key" };
      if (format === "raw") await client.requestRaw("GET", "/test", opts);
      else if (format === "multipart") {
        const form = new FormData();
        form.set("name", "file");
        await client.postFormData("/test", form, opts);
      } else await client.post("/test", { hello: "world" }, opts);
      const first = fetch.mock.calls[0]?.[1];
      const second = fetch.mock.calls[1]?.[1];
      expect(first.body).toBe(second.body);
      expect(new Headers(first.headers).get("Idempotency-Key")).toBe(
        "same-key",
      );
      expect(new Headers(second.headers).get("Authorization")).toBe(
        "Bearer token-2",
      );
      expect(new Headers(second.headers).get("DPoP")).toBeNull();
      expect(second.signal).toBe(first.signal);
    },
  );

  it.each([
    "dpop-invalid",
    "dpop-required",
    "session-revoked",
    "permission-denied",
  ])("does not refresh on %s", async (code) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => denied(code)),
    );
    const load = vi.fn(async () => ({ token: "token" }));
    await expect(
      new TilaClient({ baseUrl, token: load }).get("/a"),
    ).rejects.toBeInstanceOf(TilaApiError);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("bounds failures to two attempts for providers and one for static tokens", async () => {
    const fetch = vi.fn(async () => denied());
    vi.stubGlobal("fetch", fetch);
    await expect(
      new TilaClient({ baseUrl, token: async () => ({ token: "token" }) }).get(
        "/a",
      ),
    ).rejects.toBeInstanceOf(TilaApiError);
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockClear();
    await expect(
      new TilaClient({ baseUrl, token: "token" }).get("/a"),
    ).rejects.toBeInstanceOf(TilaApiError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("binds a fresh proof to each actual token, method, URL and key", async () => {
    const key = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const jwk = await crypto.subtle.exportKey("jwk", key.publicKey);
    const jkt = await accessTokenHash(
      JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }),
    );
    const encode = (text: string) =>
      btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const signer = vi.fn(async (context: DpopProofContext) => {
      const input = `${encode(JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk }))}.${encode(JSON.stringify({ htm: context.htm, htu: context.htu, ath: context.ath, iat: Math.floor(Date.now() / 1000), jti: crypto.randomUUID() }))}`;
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        key.privateKey,
        new TextEncoder().encode(input),
      );
      return `${input}.${encode(String.fromCharCode(...new Uint8Array(signature)))}`;
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(denied())
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetch);
    let number = 0;
    const client = new TilaClient({
      baseUrl,
      token: async () => ({
        token: `token-${++number}`,
        dpop: { jkt, signProof: signer },
      }),
    });
    await client.post("/test?query=1", {});
    expect(signer.mock.calls[0]?.[0]).toMatchObject({
      accessToken: "token-1",
      ath: await accessTokenHash("token-1"),
      htm: "POST",
      htu: `${baseUrl}/test`,
    });
    expect(signer.mock.calls[1]?.[0].ath).toBe(
      await accessTokenHash("token-2"),
    );
    expect(fetch.mock.calls[0]?.[1].headers.DPoP).not.toBe(
      fetch.mock.calls[1]?.[1].headers.DPoP,
    );
  });
});

describe("credential helpers", () => {
  const context = (): TokenProviderContext => ({
    method: "GET",
    url: `${baseUrl}/projects/project/tasks`,
    signal: new AbortController().signal,
    reason: "initial",
  });
  const exchange = () => ({
    ok: true,
    session_token: "scoped-token",
    expires_at: future(),
    project_id: "project",
    oidc_issuer: "https://issuer.test",
    oidc_subject: "workload",
    permission: "read",
    principal_id: "service:one",
    credential_id: "credential",
    token_id: "version",
  });
  it("adapts service tokens and external callbacks without taking ownership", async () => {
    expect(await createServiceTokenProvider("static")(context())).toEqual({
      token: "static",
    });
    const callback = vi.fn(async () => ({ token: "external" }));
    await createExternalTokenProvider(callback)(context());
    expect(callback).toHaveBeenCalledTimes(1);
  });
  it("obtains fresh assertions for renewals and validates scoped exchange responses", async () => {
    let number = 0;
    const getAssertion = vi.fn(async () => `assertion-${++number}`);
    const fetch = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify(exchange())),
    );
    vi.stubGlobal("fetch", fetch);
    const provider = createOidcWorkloadTokenProvider({
      baseUrl,
      projectId: "project",
      getAssertion,
    });
    await provider(context());
    await provider({ ...context(), reason: "expiry" });
    expect(
      fetch.mock.calls.map(
        (call) =>
          JSON.parse((call[1] as RequestInit).body as string).oidc_token,
      ),
    ).toEqual(["assertion-1", "assertion-2"]);
    expect(fetch.mock.calls[0]?.[0]).toBe(`${baseUrl}/api/auth/oidc/exchange`);
  });
  it.each(["workload-already-exchanged", "workload-revoked"])(
    "preserves %s without replaying exchange",
    async (code) => {
      const fetch = vi.fn(async () =>
        denied(code, code === "workload-revoked" ? 403 : 409),
      );
      vi.stubGlobal("fetch", fetch);
      const provider = createOidcWorkloadTokenProvider({
        baseUrl,
        projectId: "project",
        getAssertion: async () => "assertion",
      });
      await expect(provider(context())).rejects.toMatchObject({
        code,
        retryable: false,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    { principal_id: "github:human" },
    { credential_id: undefined },
    { project_id: "other" },
    { expires_at: 0 },
  ])("rejects non-scoped or invalid exchange results", async (override) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ...exchange(), ...override })),
      ),
    );
    const provider = createOidcWorkloadTokenProvider({
      baseUrl,
      projectId: "project",
      getAssertion: async () => "assertion",
    });
    await expect(provider(context())).rejects.toBeInstanceOf(
      TokenProviderError,
    );
  });
  it("does not retry non-retryable provider errors or cancellation", async () => {
    const load = vi.fn(async () => {
      throw new TokenProviderError("external", "Failed");
    });
    await expect(withRetry(load)).rejects.toMatchObject({ code: "external" });
    expect(load).toHaveBeenCalledTimes(1);
    const aborted = vi.fn(async () => {
      throw new DOMException("Cancelled", "AbortError");
    });
    await expect(withRetry(aborted)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(aborted).toHaveBeenCalledTimes(1);
  });
});
