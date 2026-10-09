import { afterEach, expect, it, vi } from "vitest";
import { resolveServerConfig } from "../config";
afterEach(() => vi.unstubAllEnvs());
it.each([
  "TILA_API_TOKEN",
  "TILA_TOKEN",
  "TILA_DB_PATH",
  "TILA_ARTIFACTS_PATH",
])("rejects removed %s configuration", async (key) => {
  vi.stubEnv(key, "unsupported");
  await expect(resolveServerConfig()).rejects.toMatchObject({
    code: "runtime-auth-required",
  });
});
it("does not fall back to keychain or personal sessions", async () => {
  for (const key of [
    "TILA_RUN_SOCKET",
    "TILA_RUN_CAPABILITY",
    "TILA_LIFECYCLE_CLIENT",
  ])
    vi.stubEnv(key, "");
  await expect(resolveServerConfig()).rejects.toMatchObject({
    code: "runtime-auth-required",
  });
});
it("fails closed when shared clients omit or conflict on session metadata", async () => {
  for (const key of [
    "TILA_RUN_SOCKET",
    "TILA_RUN_CAPABILITY",
    "TILA_API_TOKEN",
    "TILA_TOKEN",
  ])
    vi.stubEnv(key, "");
  vi.stubEnv("TILA_LIFECYCLE_CLIENT", "codex");
  vi.stubEnv("TILA_API_URL", "https://tila.test");
  vi.stubEnv("TILA_PROJECT_ID", "project");
  const config = await resolveServerConfig();
  await expect(config.resolveRun()).rejects.toMatchObject({
    code: "runtime-session-unavailable",
  });
  await expect(
    config.resolveRun({ sessionId: "one", threadId: "two" }),
  ).rejects.toMatchObject({ code: "runtime-session-unavailable" });
});
