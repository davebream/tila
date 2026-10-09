import {
  CREDENTIAL_PRESETS,
  type RuntimeContext,
  accessTokenHash,
} from "@tila/schemas";
import { afterEach, expect, it, vi } from "vitest";
import {
  RuntimeBroker,
  brokerRpc,
  connectRuntimeBroker,
} from "../src/runtime-broker";
import {
  generateRuntimeKey,
  runtimeBinding,
  runtimeEndpointPolicy,
} from "../src/runtime-proof";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) await close();
});
async function fixture(expiry = 900) {
  let context: RuntimeContext = {
    ok: true,
    protocol: 1,
    instance_id: crypto.randomUUID(),
    project_id: "p",
    purpose: "run",
    principal_id: "service:one",
    enrollment_id: crypto.randomUUID(),
    workload_binding_id: null,
    run_id: crypto.randomUUID(),
    participant_id: crypto.randomUUID(),
    policy: CREDENTIAL_PRESETS.worker,
    token_id: crypto.randomUUID(),
    expires_at: Math.floor(Date.now() / 1000) + expiry,
    lease_expires_at: Math.floor(Date.now() / 1000) + 300,
  };
  let token = "first-run-token";
  const binding = await runtimeBinding(
    await generateRuntimeKey(),
    "https://tila.test",
    runtimeEndpointPolicy("p", "run"),
  );
  const control = {
    renew: vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      token = "second-run-token";
      context = {
        ...context,
        token_id: crypto.randomUUID(),
        expires_at: Math.floor(Date.now() / 1000) + 900,
      };
      return { ok: true as const, token, context };
    }),
    heartbeat: vi.fn(async () => ({
      lease_expires_at: required(context.lease_expires_at),
    })),
    close: vi.fn(async () => {}),
  };
  const fetcher = vi.fn(
    async () =>
      new Response(JSON.stringify(context), {
        headers: { "Content-Type": "application/json" },
      }),
  ) as unknown as typeof fetch;
  const broker = new RuntimeBroker(
    "https://tila.test",
    { ok: true, token, context },
    binding,
    control,
    fetcher,
  );
  const reference = await broker.listen();
  cleanup.push(() => broker.close());
  return { broker, reference, control };
}
it("serves a bound run over a real Unix socket without exposing enrollment authority", async () => {
  const { reference } = await fixture();
  const connected = await connectRuntimeBroker(reference);
  const credential = await connected.provider({
    method: "GET",
    url: "https://tila.test/projects/p/tasks",
    signal: new AbortController().signal,
    reason: "initial",
  });
  expect(credential.token).toBe("first-run-token");
  expect(JSON.stringify(credential)).not.toContain("privateJwk");
  const context = {
    htm: "GET",
    htu: "https://tila.test/projects/p/tasks",
    accessToken: credential.token,
    ath: await accessTokenHash(credential.token),
    signal: new AbortController().signal,
  };
  const proof = await required(credential.dpop).signProof(context);
  expect(
    JSON.parse(Buffer.from(proof.split(".")[1], "base64url").toString()).ath,
  ).toBe(context.ath);
  await expect(
    required(credential.dpop).signProof({
      ...context,
      htu: "https://other.test/projects/p/tasks",
    }),
  ).rejects.toThrow();
  await expect(
    required(credential.dpop).signProof({
      ...context,
      htu: "https://tila.test/projects/p/runtime/runs",
    }),
  ).rejects.toThrow();
  await expect(
    brokerRpc({ ...reference, capability: "another-run" }, "/credential"),
  ).rejects.toThrow();
  await expect(brokerRpc(reference, "/start", {})).rejects.toThrow();
});
it("serializes concurrent renewal and retains the server-assigned participant", async () => {
  const { broker, control, reference } = await fixture(100);
  const participant = broker.context.participant_id;
  await Promise.all(Array.from({ length: 15 }, () => broker.tick()));
  expect(control.renew).toHaveBeenCalledTimes(1);
  const connected = await connectRuntimeBroker(reference);
  expect(connected.context.participant_id).toBe(participant);
  const credential = await connected.provider({
    method: "GET",
    url: "https://tila.test/projects/p/tasks",
    reason: "expiry",
    signal: new AbortController().signal,
  });
  expect(credential.token).toBe("second-run-token");
});
it("stops access on terminal renewal failure with no fallback", async () => {
  const { broker, control, reference } = await fixture(100);
  control.renew.mockRejectedValue(new Error("enrollment-revoked"));
  await expect(broker.tick()).rejects.toThrow();
  await expect(brokerRpc(reference, "/credential")).rejects.toThrow();
  expect(control.heartbeat).not.toHaveBeenCalled();
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing expected fixture value");
  return value;
}

it("recovers a temporary renewal timeout without changing authority", async () => {
  const { broker, control, reference } = await fixture(100);
  control.renew.mockRejectedValueOnce(
    new DOMException("Temporary timeout", "TimeoutError"),
  );
  await expect(broker.tick()).rejects.toThrow("Temporary timeout");
  await broker.tick();
  expect(control.renew).toHaveBeenCalledTimes(2);
  expect((await connectRuntimeBroker(reference)).context.run_id).toBe(
    broker.context.run_id,
  );
});
it("expires access after a missed lease even when its credential has time left", async () => {
  const { broker, control, reference } = await fixture();
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 301_000);
  await expect(brokerRpc(reference, "/credential")).rejects.toThrow();
  await expect(broker.tick()).rejects.toThrow();
  expect(control.renew).not.toHaveBeenCalled();
});
it("closes once when session end races explicit shutdown", async () => {
  const { broker, control } = await fixture();
  await Promise.all([broker.close(), broker.close()]);
  expect(control.close).toHaveBeenCalledTimes(1);
});
