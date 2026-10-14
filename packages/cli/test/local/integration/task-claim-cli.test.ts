import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { schema } from "@tila/ops-sqlite";
import { writeConfigFile } from "../../../src/config";
import { LocalProject } from "../../../src/local/local-project";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it("reports local task contention without granting authority, then acquires after release", async () => {
  const root = mkdtempSync(join(tmpdir(), "tila-task-claim-cli-"));
  roots.push(root);
  const dbPath = join(root, "state.db");
  writeConfigFile(
    {
      backend: "local",
      project_id: "claim-cli",
      schema_version: 0,
      tila_version: "0.8.0",
      created_at: new Date(0).toISOString(),
      local: {
        db_path: dbPath,
        artifacts_path: join(root, "artifacts"),
        org: "fixture",
      },
    },
    join(root, ".tila"),
  );
  const entry = resolve(import.meta.dir, "../../../src/index.ts");
  async function invoke(participant: string, ...args: string[]) {
    const child = Bun.spawn(
      [process.execPath, entry, "--participant-id", participant, ...args],
      {
        cwd: root,
        // Allow only process-launch essentials; session and runtime overrides
        // must never select a different participant, backend, or store.
        env: {
          PATH: process.env.PATH ?? "",
          HOME: root,
          TILA_HOME: join(root, "home"),
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_CACHE_HOME: join(root, "cache"),
          CI: "1",
          NO_COLOR: "1",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, status };
  }

  const created = await invoke(
    "first",
    "task",
    "new",
    "Claim regression",
    "--id",
    "T-claim",
    "--json",
  );
  expect(created.status, created.stderr).toBe(0);
  const observer = LocalProject.open(dbPath, "fixture", "claim-cli");
  const snapshot = () => ({
    claims: observer.getDb().select().from(schema.claims).all(),
    fences: observer.getDb().select().from(schema.fences).all(),
  });
  try {
    const first = await invoke("first", "task", "claim", "T-claim", "--json");
    expect(first.status, first.stderr).toBe(0);
    expect(first.stderr).toBe("");
    const acquired = JSON.parse(first.stdout);
    expect(acquired).toEqual({
      ok: true,
      result: {
        acquired: true,
        fence: expect.any(Number),
        expires_at: expect.any(String),
        participant_id: "first",
      },
    });
    const before = snapshot();
    expect(before.claims).toHaveLength(1);
    expect(before.claims[0]).toMatchObject({
      resource: "task:T-claim",
      participant_id: "first",
      fence: acquired.result.fence,
      expires_at: Date.parse(acquired.result.expires_at),
    });
    expect(acquired.result.fence).toBeGreaterThan(0);
    expect(acquired.result.expires_at).toBe(
      new Date(before.claims[0].expires_at).toISOString(),
    );

    for (const json of [true, false]) {
      const losing = await invoke(
        "second",
        "task",
        "claim",
        "T-claim",
        ...(json ? ["--json"] : []),
      );
      expect(losing.status).toBe(1);
      expect(losing.stdout).toBe("");
      if (json) {
        expect(JSON.parse(losing.stderr)).toEqual({
          ok: false,
          error: {
            kind: "already-held",
            message: expect.stringContaining("T-claim"),
            retryable: false,
          },
        });
      } else {
        expect(losing.stderr).toContain("Task T-claim is already held");
        expect(losing.stderr).toContain("release");
        expect(losing.stderr.trim().split("\n")).toHaveLength(1);
      }
      expect(losing.stderr).not.toMatch(
        /fence|participant|1970-01-01|Claimed task/,
      );
      expect(snapshot()).toEqual(before);
    }

    const released = await invoke(
      "first",
      "task",
      "release",
      "T-claim",
      "--fence",
      String(acquired.result.fence),
      "--json",
    );
    expect(released.status, released.stderr).toBe(0);
    expect(JSON.parse(released.stdout)).toEqual({ ok: true, result: {} });
    expect(snapshot().claims).toEqual([]);

    const second = await invoke("second", "task", "claim", "T-claim");
    expect(second.status, second.stderr).toBe(0);
    expect(second.stderr).toBe("");
    const after = snapshot();
    expect(after.claims).toHaveLength(1);
    expect(after.claims[0].participant_id).toBe("second");
    expect(after.claims[0].fence).toBe(acquired.result.fence + 1);
    expect(second.stdout.trim()).toBe(
      `Claimed task T-claim  fence=${after.claims[0].fence}  participant=second  expires=${new Date(after.claims[0].expires_at).toISOString()}`,
    );
  } finally {
    observer.close();
  }
}, 20000);
