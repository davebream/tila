import { AsyncLocalStorage } from "node:async_hooks";

export const TIMING_NAMES = [
  "worker",
  "auth_rate_limit",
  "auth_token",
  "auth_credential",
  "membership",
  "transfer",
  "do",
  "worker_other",
] as const;
export type ServerTimings = Record<(typeof TIMING_NAMES)[number], number>;
export interface HttpTimingSample {
  server?: ServerTimings;
  colo?: string;
  placement?: string;
}

export const timingContext = new AsyncLocalStorage<HttpTimingSample[]>();

/** Only accept our complete, finite timing contract; other vendors are ignored. */
export function parseServerTiming(
  header: string | null,
): ServerTimings | undefined {
  const values: Partial<ServerTimings> = {};
  for (const entry of (header ?? "").split(",")) {
    const match = /^\s*tila_(\w+)\s*;\s*dur=([\d.]+)\s*$/.exec(entry);
    if (!match) {
      if (/^\s*tila_/.test(entry)) return undefined;
      continue;
    }
    const name = match[1] as keyof ServerTimings;
    if (!TIMING_NAMES.includes(name)) continue;
    const value = Number(match[2]);
    if (!Number.isFinite(value) || value < 0 || values[name] !== undefined)
      return undefined;
    values[name] = value;
  }
  if (!TIMING_NAMES.every((name) => values[name] !== undefined))
    return undefined;
  const timings = values as ServerTimings;
  const sum = TIMING_NAMES.filter((n) => n !== "worker").reduce(
    (s, n) => s + timings[n],
    0,
  );
  if (Math.abs(sum - timings.worker) > 0.02) return undefined;
  return timings;
}

/** Capture headers only. The SDK retains ownership of the response stream. */
export function captureHttpTiming(response: Response): void {
  timingContext.getStore()?.push({
    server: parseServerTiming(response.headers.get("server-timing")),
    colo: response.headers.get("cf-ray")?.split("-").at(-1),
    placement: response.headers.get("cf-placement") ?? undefined,
  });
}
