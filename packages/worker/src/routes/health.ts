import { Hono } from "hono";

export const WORKER_VERSION = "0.1.0";
export const API_VERSION = 1;
export const MIN_CLI_VERSION = "0.1.0";

export const health = new Hono();

health.get("/health", (c) => {
  return c.json({
    ok: true as const,
    version: WORKER_VERSION,
    apiVersion: API_VERSION,
    minCliVersion: MIN_CLI_VERSION,
  });
});
