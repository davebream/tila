/**
 * HTTP tier: `TilaClient` per participant against any Worker URL — a local
 * `wrangler dev` on :8787 or a deployed Cloudflare instance. This is the only
 * tier that measures the full path (auth, D1, both DO hops, network).
 */
import os from "node:os";
import { StoreCountsResponseSchema } from "@tila/schemas";
import { TilaClient } from "tila-sdk";
import { probeRegion } from "../region";
import { HARNESS_VERSION } from "../result-schema";
import type { Driver, Participant, RegionInfo } from "../types";
import { facadeFromClient } from "./facade";

export interface HttpDriverOptions {
  runId: string;
  baseUrl: string;
  token: string;
  /** One token per principal; participant i uses tokens[i % tokens.length]. */
  tokens?: string[];
  projectId: string;
  sweepSecret?: string;
  region?: string;
  timeoutMs?: number;
}

export function createHttpDriver(opts: HttpDriverOptions): Driver {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const tokens =
    opts.tokens && opts.tokens.length > 0 ? opts.tokens : [opts.token];
  const principalByToken = new Map<string, string>();
  let region: RegionInfo | undefined;
  const host = new URL(baseUrl).hostname;
  const deployed = !isLocal(host);

  async function principalFor(token: string): Promise<string> {
    const cached = principalByToken.get(token);
    if (cached) return cached;
    const res = await fetch(`${baseUrl}/api/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    if (!res.ok)
      throw new Error(
        `GET /api/whoami failed: HTTP ${res.status} ${await res.text()}`,
      );
    const body = (await res.json()) as { principal_id?: string };
    if (!body.principal_id)
      throw new Error(
        "GET /api/whoami returned no principal_id; token cannot mutate",
      );
    principalByToken.set(token, body.principal_id);
    return body.principal_id;
  }

  function rawFetch(token: string, participantId: string) {
    return (path: string, init?: RequestInit) =>
      fetch(`${baseUrl}${path.startsWith("/") ? path : `/${path}`}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Tila-Participant-Id": participantId,
          "X-Tila-Source": `tila-bench/${HARNESS_VERSION}`,
          ...(init?.headers as Record<string, string> | undefined),
        },
        signal: init?.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
  }

  const adminFetch = () => rawFetch(opts.token, `bench-${opts.runId}-admin`);

  return {
    tier: "http",
    describe: () => ({
      base_url_host: host,
      deployed,
      region,
      notes: [
        deployed
          ? "Deployed Cloudflare Worker: full path incl. auth, D1, two DO hops, network RTT."
          : "Local wrangler dev: full Worker path over loopback (miniflare D1/DO/R2).",
      ],
    }),
    async participants(n, principals) {
      region = await probeRegion(baseUrl, opts.region);
      if (principals > tokens.length)
        throw new Error(
          `--principals ${principals} needs ${principals} tokens; got ${tokens.length}. Pass TILA_BENCH_TOKENS as a comma-separated list (one per principal).`,
        );
      const participants: Participant[] = [];
      for (let i = 0; i < n; i++) {
        const token = tokens[i % principals];
        const participantId = `bench-${opts.runId}-p${i}`;
        const client = new TilaClient({
          baseUrl,
          token,
          participantId,
          environment: {
            client_name: "tila-bench",
            client_version: HARNESS_VERSION,
            machine: os.hostname(),
          },
          timeoutMs: opts.timeoutMs ?? 30_000,
        });
        participants.push({
          index: i,
          participantId,
          projectId: opts.projectId,
          principalId: await principalFor(token),
          tila: facadeFromClient(client, opts.projectId),
          rawFetch: rawFetch(token, participantId),
        });
      }
      return participants;
    },
    async sampleStore() {
      const res = await adminFetch()(
        `/projects/${opts.projectId}/admin/store-counts`,
      );
      if (!res.ok)
        throw new Error(
          `store-counts failed: HTTP ${res.status} (needs a full-scope token)`,
        );
      const body = StoreCountsResponseSchema.parse(await res.json());
      return {
        db_bytes: body.db_bytes,
        counts: {
          ...body.counts.domain,
          _schema_history: body.counts.schemaHistory,
        },
      };
    },
    sweep: opts.sweepSecret
      ? async () => {
          const t0 = performance.now();
          const res = await fetch(`${baseUrl}/_internal/sweep`, {
            method: "POST",
            headers: { "X-Sweep-Secret": opts.sweepSecret as string },
            signal: AbortSignal.timeout(60_000),
          });
          const ms = performance.now() - t0;
          if (!res.ok) throw new Error(`sweep failed: HTTP ${res.status}`);
          const body = (await res.json()) as Record<string, unknown>;
          const out: Record<string, number> = { sweep_ms: Math.round(ms) };
          for (const [k, v] of Object.entries(body))
            if (typeof v === "number") out[k] = v;
          return out;
        }
      : undefined,
    async restart() {
      const res = await adminFetch()(
        `/projects/${opts.projectId}/admin/restart`,
        {
          method: "POST",
        },
      );
      if (res.status === 403)
        throw new Error(
          "POST /admin/restart returned 403: TILA_TOKEN must be full-scope",
        );
      if (!res.ok)
        throw new Error(`POST /admin/restart failed: HTTP ${res.status}`);
    },
    async cleanup() {},
  };
}

function isLocal(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".localhost")
  );
}
