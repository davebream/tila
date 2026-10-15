import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CloudBackupEndpoint,
  TilaOperatorClient,
  exportProjectBackup,
} from "../backup";

type Captured = { url: string; method: string; headers: Headers };

let captured: Captured[];
let respond: () => Response;

beforeEach(() => {
  captured = [];
  respond = () => Response.json({ ok: true });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    captured.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
    });
    return respond();
  });
});
afterEach(() => vi.restoreAllMocks());

const endpoint = (overrides: Partial<CloudBackupEndpoint> = {}) =>
  ({
    backend: "cloud",
    projectId: "demo",
    baseUrl: "https://tila.example/",
    token: "project-token",
    ...overrides,
  }) satisfies CloudBackupEndpoint;

describe("TilaOperatorClient participant identity", () => {
  it("sends the supplied participant on reads and mutations", async () => {
    const client = new TilaOperatorClient(
      endpoint({ participantId: "operator-1" }),
    );
    await client.request("/transfer/status");
    await client.request("/transfer/begin", { method: "POST" });

    expect(captured.map((call) => call.method)).toEqual(["GET", "POST"]);
    for (const call of captured) {
      expect(call.headers.get("X-Tila-Participant-Id")).toBe("operator-1");
      expect(call.headers.get("Authorization")).toBe("Bearer project-token");
    }
    expect(captured[0]?.headers.has("X-Confirm-Slug")).toBe(false);
    expect(captured[1]?.headers.get("X-Confirm-Slug")).toBe("demo");
    expect(captured[0]?.url).toBe(
      "https://tila.example/projects/demo/admin/backup/transfer/status",
    );
  });

  it("generates one participant per client when none is supplied", async () => {
    const client = new TilaOperatorClient(endpoint());
    await client.request("/transfer/status");
    await client.request("/transfer/begin", { method: "POST" });
    const other = new TilaOperatorClient(endpoint());

    const [first, second] = captured.map((call) =>
      call.headers.get("X-Tila-Participant-Id"),
    );
    expect(first).toBeTruthy();
    expect(first).toBe(second);
    expect(first).toBe(client.participantId);
    expect(other.participantId).not.toBe(client.participantId);
  });

  it.each([
    ["empty", ""],
    ["oversized", "p".repeat(256)],
  ])("rejects a %s participant before any request", (_label, participantId) => {
    expect(() => new TilaOperatorClient(endpoint({ participantId }))).toThrow();
    expect(captured).toHaveLength(0);
  });

  it("keeps the infrastructure route and credential unchanged", async () => {
    const client = new TilaOperatorClient(
      endpoint({ token: undefined, infraToken: "infra-secret" }),
    );
    await client.request("/transfer/begin", { method: "POST" });

    expect(captured[0]?.url).toBe(
      "https://tila.example/_internal/admin/projects/demo/backup/transfer/begin",
    );
    expect(captured[0]?.headers.get("Authorization")).toBe(
      "Bearer infra-secret",
    );
  });

  it("lets a caller header override the default participant", async () => {
    const client = new TilaOperatorClient(
      endpoint({ participantId: "operator-1" }),
    );
    await client.request("/transfer/status", {
      headers: { "X-Tila-Participant-Id": "override" },
    });
    expect(captured[0]?.headers.get("X-Tila-Participant-Id")).toBe("override");
  });
});

describe("cloud project export", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tila-operator-test-"));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("identifies the participant on the first transfer request", async () => {
    respond = () => new Response("refused", { status: 500 });
    const output = join(root, "backup.tila-backup");

    await expect(
      exportProjectBackup({
        source: endpoint({ participantId: "cli-participant" }),
        output,
      }),
    ).rejects.toThrow("Backup operator request failed (500)");

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe(
      "https://tila.example/projects/demo/admin/backup/transfer/begin",
    );
    expect(captured[0]?.headers.get("X-Tila-Participant-Id")).toBe(
      "cli-participant",
    );
    expect(existsSync(output)).toBe(false);
  });
});
