import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Lifecycle, SessionStore } from "@tila/client-lifecycle";
import { afterEach, expect, it, vi } from "vitest";
import {
  resetGlobalFlags,
  resolveParticipantId,
  setGlobalFlags,
} from "./global-flags";
vi.mock("../config", () => ({
  findConfig: () => ({
    worker_url: "https://tila.example",
    project_id: "test",
  }),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  resetGlobalFlags();
});
it("uses each native shell session identity and preserves explicit overrides", async () => {
  const root = mkdtempSync(join(tmpdir(), "tila-cli-identity-"));
  vi.stubEnv("TILA_HOME", root);
  vi.stubEnv("TILA_PARTICIPANT_ID", "");
  vi.stubEnv("TILA_LIFECYCLE_KEY", "");
  const lifecycle = new Lifecycle(
    new SessionStore(),
    JSON.stringify(["https://tila.example", "test"]),
    async () => {
      throw new Error("offline");
    },
  );
  try {
    const start = (session_id: string) =>
      lifecycle.start(
        "codex",
        { session_id, cwd: root, hook_event_name: "SessionStart" },
        null,
        { client_name: "codex", machine: "shared-host" },
      );
    const a = await start("one");
    const b = await start("two");
    vi.stubEnv("CODEX_THREAD_ID", "one");
    expect(resolveParticipantId()).toMatchObject({
      id: a.state.participantId,
      explicit: true,
      environment: { client_name: "codex" },
    });
    vi.stubEnv("CODEX_THREAD_ID", "two");
    expect(resolveParticipantId().id).toBe(b.state.participantId);
    setGlobalFlags({ participantId: "explicit" });
    expect(resolveParticipantId().id).toBe("explicit");
    resetGlobalFlags();
    vi.stubEnv("CODEX_THREAD_ID", "");
    vi.stubEnv("TILA_LIFECYCLE_KEY", a.state.key);
    vi.stubEnv("TILA_PARTICIPANT_ID", a.state.participantId);
    expect(resolveParticipantId().environment?.machine).toBe("shared-host");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
