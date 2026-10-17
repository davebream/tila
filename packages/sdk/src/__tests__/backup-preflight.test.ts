import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ImportProjectBackupOptions,
  importProjectBackup,
  inspectProjectBackup,
} from "../backup";
import { legacyV070Archive } from "./fixtures/legacy-backup/v0.7.0-archive";

let root: string;
let archive: string;
let projectId: string;
let digest: string;
let calls: { path: string; method: string; headers: Headers }[];
let capabilityResponse: () => Response;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tila-preflight-"));
  archive = join(root, "backup.tila-backup");
  await writeFile(archive, legacyV070Archive());
  const { manifest } = await inspectProjectBackup(archive);
  projectId = manifest.project_id;
  digest = manifest.content_root;
  expect(manifest.required_features).toEqual(
    expect.arrayContaining(["work-questions-v1", "attempt-corrections-v1"]),
  );
  calls = [];
  capabilityResponse = () => Response.json({ migrationVersion: 40 });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push({
      path,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
    });
    if (path.endsWith("/bootstrap")) return Response.json({ created: false });
    if (path.endsWith("/capabilities")) return capabilityResponse();
    if (path.endsWith("/transfer/status"))
      return Response.json({ state: null });
    // Stop after preflight; the runtime round trip exercises real transfers.
    return new Response("transfer sentinel", { status: 500 });
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe.each(["project", "infra", "checkpoint"] as const)(
  "cloud import preflight (%s)",
  (mode) => {
    function options(): ImportProjectBackupOptions {
      return {
        archive,
        replace: true,
        destination: {
          backend: "cloud",
          projectId,
          baseUrl: "https://tila.example",
          participantId: "restore-operator",
          ...(mode === "project"
            ? { token: "project-token" }
            : { infraToken: "infra-token" }),
        },
        ...(mode === "checkpoint"
          ? {
              recovery: {
                operationId: "recovery-1",
                context: {
                  policy: "preserve-current-access" as const,
                  checkpoint: {
                    version: 1 as const,
                    id: "checkpoint-1",
                    project_id: projectId,
                    instance: "https://tila.example",
                    account_id: "local",
                    snapshot_at: new Date(0).toISOString(),
                  },
                  requested_at: new Date(0).toISOString(),
                  archive_digest: digest,
                  safety_archive: join(root, "safety.tila-backup"),
                },
              },
            }
          : {}),
      };
    }

    function expectOnlyPreflight() {
      const prefix =
        mode === "project"
          ? `/projects/${projectId}/admin/backup`
          : `/_internal/admin/projects/${projectId}/backup`;
      expect(calls.map(({ path, method }) => ({ path, method }))).toEqual([
        ...(mode === "infra"
          ? [{ path: `${prefix}/bootstrap`, method: "POST" }]
          : []),
        { path: `${prefix}/capabilities`, method: "GET" },
      ]);
      for (const call of calls) {
        expect(call.headers.get("Authorization")).toBe(
          `Bearer ${mode === "project" ? "project-token" : "infra-token"}`,
        );
        expect(call.headers.get("X-Tila-Participant-Id")).toBe(
          "restore-operator",
        );
      }
    }

    it.each([
      [35, "work-questions-v1"],
      [36, "attempt-corrections-v1"],
      [39, "attempt-corrections-v1"],
      [undefined, "work-questions-v1"],
      [null, "work-questions-v1"],
      ["40", "work-questions-v1"],
      [40.5, "work-questions-v1"],
    ])(
      "rejects migration version %s before starting a transfer",
      async (migrationVersion, feature) => {
        capabilityResponse = () => Response.json({ migrationVersion });
        await expect(importProjectBackup(options())).rejects.toThrow(
          `Destination does not support ${feature}; upgrade the Worker before restoring`,
        );
        expectOnlyPreflight();
      },
    );

    it.each([401, 403, 500])(
      "propagates HTTP %s before starting a transfer",
      async (status) => {
        capabilityResponse = () =>
          new Response("capabilities unavailable", { status });
        await expect(importProjectBackup(options())).rejects.toThrow(
          `Backup operator request failed (${status}): capabilities unavailable`,
        );
        expectOnlyPreflight();
      },
    );

    it("propagates transport failures before starting a transfer", async () => {
      capabilityResponse = () => {
        throw new Error("connection lost");
      };
      await expect(importProjectBackup(options())).rejects.toThrow(
        "connection lost",
      );
      expectOnlyPreflight();
    });

    it("checks both features with one capability request before safety export", async () => {
      await expect(importProjectBackup(options())).rejects.toThrow(
        "transfer sentinel",
      );
      expect(
        calls.filter(({ path }) => path.endsWith("/capabilities")),
      ).toHaveLength(1);
      expect(calls.some(({ path }) => path.endsWith("/transfer/meta"))).toBe(
        false,
      );
      expect(calls.at(-1)?.path).toMatch(/\/transfer\/begin$/);
    });
  },
);
