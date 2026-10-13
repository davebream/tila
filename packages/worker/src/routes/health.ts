import { Hono } from "hono";
import { BUILD_COMMIT, PRODUCT_VERSION } from "../version";

// Protocol compatibility is versioned independently of the product release.
export const API_VERSION = 1;
export const MIN_CLI_VERSION = "0.1.0";

export const health = new Hono();

health.get("/health", (c) => {
  return c.json({
    ok: true as const,
    version: PRODUCT_VERSION,
    commit: BUILD_COMMIT,
    apiVersion: API_VERSION,
    minCliVersion: MIN_CLI_VERSION,
    features: ["managed-queue-v1", "work-questions-v1", "attempt-control-v1"],
  });
});
