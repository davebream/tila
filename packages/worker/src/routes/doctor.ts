import { Hono } from "hono";
import { forwardToDO } from "../lib/do-forward";
import { requirePermission } from "../middleware/permission";
import type { Env, HonoVariables } from "../types";

type DoctorEnv = { Bindings: Env; Variables: HonoVariables };

export const doctor = new Hono<DoctorEnv>();

doctor.get("/doctor/search-drift", requirePermission("admin"), async (c) => {
  const stub = c.get("doStub");
  const res = await forwardToDO(stub, "/artifact/search-drift", "GET");
  if (!res.ok) {
    return c.json(
      {
        ok: false,
        error: {
          code: "do-unreachable",
          message: `Backend returned ${res.status}`,
          retryable: true,
        },
      },
      502,
    );
  }
  return c.json(await res.json());
});

doctor.get("/doctor/schema", requirePermission("admin"), async (c) => {
  const stub = c.get("doStub");

  // Try the new DO-side diagnostic route first
  const res = await forwardToDO(stub, "/doctor/schema", "GET");
  const body = (await res.json()) as Record<string, unknown>;
  if (body.sqlite_version || body.do_code_version) return c.json(body);

  // Fallback: the DO is running old code without /doctor/schema.
  // Probe indirectly by attempting a claim acquire and checking the error.
  const probeRes = await forwardToDO(stub, "/coord/acquire", "POST", {
    resource: "__probe__schema__",
    machine: "__probe__",
    user: "__probe__",
    mode: "exclusive",
    ttl_ms: 1000,
  });
  const probeBody = (await probeRes.json()) as Record<string, unknown>;

  // If acquire succeeded, release immediately
  if (probeBody.ok) {
    const fence = (probeBody as { fence: number }).fence;
    await forwardToDO(stub, "/coord/release", "POST", {
      resource: "__probe__schema__",
      fence,
      actor: "__probe__/__probe__",
    });
  }

  return c.json({
    ok: true,
    stale_do: true,
    message: "Backend is running old code. Diagnostic endpoint not available.",
    probe_result: probeBody,
  });
});

doctor.get("/doctor/probe", requirePermission("admin"), async (c) => {
  const stub = c.get("doStub");

  // 1. DO health check with RTT measurement
  const t0 = Date.now();
  const doRes = await forwardToDO(stub, "/coord/health", "GET");
  const doRttMs = Date.now() - t0;

  if (!doRes.ok) {
    return c.json(
      {
        ok: false,
        error: {
          code: "do-unreachable",
          message: `Backend returned ${doRes.status}`,
          retryable: true,
        },
      },
      502,
    );
  }

  const doHealth = (await doRes.json()) as {
    ok: boolean;
    expiredClaimsCount: number;
    journalRows: number;
    maxSeq: number;
  };

  // 2. R2 reachability probe
  let r2Reachable = false;
  try {
    await c.env.ARTIFACTS.list({ prefix: "produced/", limit: 1 });
    r2Reachable = true;
  } catch {
    r2Reachable = false;
  }

  return c.json({
    ok: true as const,
    doRttMs,
    doHealth: {
      ok: true as const,
      expiredClaimsCount: doHealth.expiredClaimsCount,
      journalRows: doHealth.journalRows,
      maxSeq: doHealth.maxSeq,
    },
    r2Reachable,
  });
});
