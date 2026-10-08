import type { RegionInfo } from "./types";

/**
 * Best-effort region detection for the http tier. Cloudflare stamps every
 * response with `cf-ray: <id>-<COLO>`; Smart Placement additionally reports
 * `cf-placement`. Both are absent on `wrangler dev`.
 */
export async function probeRegion(
  baseUrl: string,
  user?: string,
): Promise<RegionInfo | undefined> {
  const info: RegionInfo = {};
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    const ray = res.headers.get("cf-ray");
    const colo = ray?.split("-")[1];
    if (colo) info.cf_colo = colo;
    const placement = res.headers.get("cf-placement");
    if (placement) info.cf_placement = placement;
  } catch {
    // Unreachable /api/health is reported by the run itself.
  }
  if (user) info.user = user;
  return Object.keys(info).length > 0 ? info : undefined;
}

export function isLocalHost(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]" ||
      host.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}
