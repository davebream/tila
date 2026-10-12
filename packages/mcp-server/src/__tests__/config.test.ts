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

it("requires explicit complete local configuration and rejects mixed remote authority", async () => {
  for (const key of [
    "TILA_RUN_SOCKET",
    "TILA_RUN_CAPABILITY",
    "TILA_API_URL",
    "TILA_API_TOKEN",
    "TILA_TOKEN",
    "TILA_DB_PATH",
    "TILA_ARTIFACTS_PATH",
  ])
    vi.stubEnv(key, "");
  vi.stubEnv("TILA_MODE", "local");
  await expect(resolveServerConfig()).rejects.toMatchObject({
    code: "runtime-auth-required",
  });
  vi.stubEnv("TILA_PROJECT_ID", "local-project");
  vi.stubEnv("TILA_DB_PATH", "/fixture/project.db");
  vi.stubEnv("TILA_ARTIFACTS_PATH", "/fixture/artifacts");
  vi.stubEnv("TILA_PARTICIPANT_ID", "local-worker");
  expect(await resolveServerConfig()).toMatchObject({
    mode: "local",
    projectId: "local-project",
    local: { participantId: "local-worker" },
  });
  vi.stubEnv("TILA_API_TOKEN", "remote-secret");
  await expect(resolveServerConfig()).rejects.toMatchObject({
    code: "runtime-binding-mismatch",
  });
});
