import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { SELF, runInDurableObject } from "cloudflare:test";
import { projectTransferOps, schema } from "@tila/ops-sqlite";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { drizzle } from "drizzle-orm/durable-sqlite";
import * as tar from "tar-stream";
import {
  TilaClient,
  createArtifactMethods,
  createSchemaMethods,
} from "tila-sdk";
import { expect, it, vi } from "vitest";
import {
  exportProjectBackup,
  importProjectBackup,
  inspectProjectBackup,
} from "../../sdk/src/backup";
import { D1TokenStore } from "../../worker/src/d1";
import { projects } from "../../worker/src/d1/schema";
import { hashToken } from "../../worker/src/lib/hash-token";
import { bindings } from "./setup";

// Cloud backup never opens a local SQLite database. Keep its Node-only driver
// (and filesystem mount probe) out of this Workers test runtime.
vi.mock("../../sdk/src/local/connection", () => ({
  createNodeConnection: () => {
    throw new Error("Cloud backup must not open local SQLite");
  },
}));

// Two restores each export a safety archive and transfer every snapshot table.
// Allow for the full suite contending for the local Cloudflare runtime.
it("restores an ordinary cloud export with empty question and correction tables", async () => {
  const projectId = "backup-roundtrip";
  const token = `tila_${crypto.randomUUID()}${crypto.randomUUID()}`;
  await drizzleD1(bindings.DB).insert(projects).values({
    project_id: projectId,
    display_name: "Backup round trip",
    created_by: "fixture",
    created_at: 0,
    cloudflare_account_id: "local",
  });
  await new D1TokenStore(bindings.DB).issue({
    projectId,
    tokenHash: await hashToken(token, bindings.HASH_PEPPER),
    name: "owner",
    createdBy: "fixture",
    createdAt: 0,
  });
  const endpoint = {
    backend: "cloud" as const,
    projectId,
    baseUrl: "https://worker",
    token,
    participantId: "backup-operator",
  };
  const requests: URL[] = [];
  let reportedMigrationVersion: number | undefined;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    requests.push(url);
    const response = await SELF.fetch(input, init);
    if (
      url.pathname.endsWith("/capabilities") &&
      reportedMigrationVersion !== undefined
    ) {
      expect(response.status).toBe(200);
      return Response.json({
        ...(await response.json<Record<string, unknown>>()),
        migrationVersion: reportedMigrationVersion,
      });
    }
    return response;
  });
  const stub = bindings.PROJECT.get(bindings.PROJECT.idFromName(projectId));
  await (await stub.fetch("https://project/admin/transfer/status")).json();
  await runInDurableObject(stub, (_instance, state) => {
    const db = drizzle(state.storage, { schema });
    db.insert(schema.entities)
      .values({
        id: "saved-task",
        type: "task",
        schema_version: 1,
        data: JSON.stringify({ name: "Original" }),
        created_at: 1000,
        updated_at: 1000,
        created_by: "fixture",
      })
      .run();
    db.insert(schema.journal)
      .values({
        t: 1000,
        kind: "entity.created",
        resource: "task:saved-task",
        principal_id: "fixture",
        participant_id: "backup-operator",
        actor: "fixture",
        data: JSON.stringify({ name: "Original" }),
      })
      .run();
  });
  const snapshot = () =>
    runInDurableObject(stub, (_instance, state) => {
      const db = drizzle(state.storage, { schema });
      return {
        tasks: db.select().from(schema.entities).all(),
        journal: db.select().from(schema.journal).all(),
        transfer: projectTransferOps.getTransferState(state.storage.sql),
      };
    });
  const original = await snapshot();
  const root = mkdtempSync("/tmp/tila-backup-roundtrip-");
  try {
    const archive = `${root}/original.tila-backup`;
    const manifest = await exportProjectBackup({
      source: endpoint,
      output: archive,
    });
    expect(manifest.required_features).toEqual(
      expect.arrayContaining(["work-questions-v1", "attempt-corrections-v1"]),
    );
    expect(manifest.stats.objects).toBe(0);
    for (const table of [
      "work_questions",
      "question_receipts",
      "attempt_corrections",
    ])
      expect(
        manifest.entries.find((entry) => entry.path === `do/${table}.jsonl`)
          ?.bytes,
      ).toBe(0);

    await runInDurableObject(stub, (_instance, state) => {
      const db = drizzle(state.storage, { schema });
      db.update(schema.entities)
        .set({ data: JSON.stringify({ name: "Changed" }) })
        .run();
      db.insert(schema.journal)
        .values({
          t: 2000,
          kind: "entity.updated",
          resource: "task:saved-task",
          principal_id: "fixture",
          participant_id: "backup-operator",
          actor: "fixture",
          data: JSON.stringify({ name: "Changed" }),
        })
        .run();
    });
    const changed = await snapshot();
    // Simulate older Workers while retaining real authorization and storage.
    for (const [version, feature] of [
      [35, "work-questions-v1"],
      [39, "attempt-corrections-v1"],
    ] as const) {
      reportedMigrationVersion = version;
      requests.length = 0;
      await expect(
        importProjectBackup({ archive, destination: endpoint, replace: true }),
      ).rejects.toThrow(`Destination does not support ${feature}`);
      expect(requests.map((url) => url.pathname)).toEqual([
        `/projects/${projectId}/admin/backup/capabilities`,
      ]);
      expect(await snapshot()).toEqual(changed);
    }
    reportedMigrationVersion = undefined;
    requests.length = 0;
    const restored = await importProjectBackup({
      archive,
      destination: endpoint,
      replace: true,
    });
    expect(await snapshot()).toEqual(original);
    expect(requests[0]?.pathname).toBe(
      `/projects/${projectId}/admin/backup/capabilities`,
    );
    expect(
      requests.filter((url) => url.pathname.endsWith("/capabilities")),
    ).toHaveLength(1);
    const metadataRequests = requests.filter((url) =>
      url.pathname.endsWith("/transfer/meta"),
    );
    expect(metadataRequests.length).toBeGreaterThan(0);
    for (const url of metadataRequests)
      expect(url.searchParams.get("sessionId")).toBeTruthy();

    expect(restored.safetyBackup).toBeTruthy();
    const safetyArchive = restored.safetyBackup as string;
    expect((await inspectProjectBackup(safetyArchive)).manifest.complete).toBe(
      true,
    );
    await importProjectBackup({
      archive: safetyArchive,
      destination: endpoint,
      replace: true,
    });
    expect(await snapshot()).toEqual(changed);

    const missingSession = await SELF.fetch(
      `https://worker/projects/${projectId}/admin/backup/transfer/meta`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Tila-Participant-Id": endpoint.participantId,
        },
      },
    );
    expect(missingSession.status).toBe(400);
    expect(await missingSession.json()).toMatchObject({
      error: { message: "sessionId is required" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);

async function readArchiveEntries(
  archive: string,
): Promise<Map<string, Buffer>> {
  const extract = tar.extract();
  const reading = pipeline(Readable.from([readFileSync(archive)]), extract);
  const entries = new Map<string, Buffer>();
  for await (const entry of extract) {
    const chunks: Buffer[] = [];
    for await (const chunk of entry) chunks.push(Buffer.from(chunk));
    entries.set(entry.header.name, Buffer.concat(chunks));
  }
  await reading;
  return entries;
}

it("exports and restores a deleted plain artifact without fetching its removed blob", async () => {
  const projectId = "backup-deleted-artifact";
  const token = `tila_${crypto.randomUUID()}${crypto.randomUUID()}`;
  await drizzleD1(bindings.DB).insert(projects).values({
    project_id: projectId,
    display_name: "Deleted artifact backup",
    created_by: "fixture",
    created_at: 0,
    cloudflare_account_id: "local",
  });
  await new D1TokenStore(bindings.DB).issue({
    projectId,
    tokenHash: await hashToken(token, bindings.HASH_PEPPER),
    name: "owner",
    createdBy: "fixture",
    createdAt: 0,
  });
  const endpoint = {
    backend: "cloud" as const,
    projectId,
    baseUrl: "https://worker",
    token,
    participantId: "backup-operator",
  };
  const requests: URL[] = [];
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    requests.push(new URL(String(input)));
    return SELF.fetch(input, { ...init, redirect: "manual" });
  });
  const client = new TilaClient({ ...endpoint, fetch });
  await createSchemaMethods(client, projectId).apply(`schema_version = 1
[artifacts.binary]
mime_types = ["application/octet-stream"]
`);
  const artifacts = createArtifactMethods(client, projectId);
  const bytes = Uint8Array.from({ length: 513 }, (_, index) => index % 256);
  const uploaded = await artifacts.upload(
    new File([bytes], "fixture.bin", { type: "application/octet-stream" }),
    { kind: "binary" },
  );
  expect(uploaded.key.startsWith("versioned/")).toBe(false);
  expect(uploaded.bytes).toBe(bytes.length);
  expect(await artifacts.meta(uploaded.key)).toMatchObject({
    pointer: { tombstoned: 0, blob_deleted_at: null, expires_at: null },
  });
  const download = await artifacts.download(uploaded.key);
  expect(await new Response(download.body).arrayBuffer()).toEqual(bytes.buffer);

  const stub = bindings.PROJECT.get(bindings.PROJECT.idFromName(projectId));
  const snapshot = () =>
    runInDurableObject(stub, (_instance, state) => {
      const db = drizzle(state.storage, { schema });
      return {
        pointers: db.select().from(schema.artifactPointers).all(),
        journal: db.select().from(schema.journal).all(),
        transfer: projectTransferOps.getTransferState(state.storage.sql),
      };
    });
  const root = mkdtempSync("/tmp/tila-backup-deleted-artifact-");
  try {
    const before = `${root}/before.tila-backup`;
    const originalManifest = await exportProjectBackup({
      source: endpoint,
      output: before,
    });
    expect(originalManifest.stats.objects).toBe(1);
    expect((await inspectProjectBackup(before)).manifest.complete).toBe(true);
    const originalEntries = await readArchiveEntries(before);
    const originalObject = JSON.parse(
      originalEntries.get("objects.jsonl")?.toString().trim() ?? "",
    );
    expect(originalObject).toMatchObject({
      key: uploaded.key,
      blob_deleted: false,
      tombstoned: false,
    });
    expect(originalEntries.get(originalObject.blob_path)).toEqual(
      Buffer.from(bytes),
    );

    const idempotencyKey = crypto.randomUUID();
    await artifacts.delete(uploaded.key, { idempotencyKey });
    // Retry the same SDK deletion after the R2 object is already absent.
    await artifacts.delete(uploaded.key, { idempotencyKey });
    expect(await bindings.ARTIFACTS.head(uploaded.key)).toBeNull();
    expect(await artifacts.meta(uploaded.key)).toMatchObject({
      pointer: {
        tombstoned: 1,
        blob_deleted_at: expect.any(Number),
      },
    });
    const deleted = await snapshot();
    expect(deleted.pointers).toHaveLength(1);
    expect(deleted.pointers[0]).toMatchObject({
      tombstoned: 1,
      blob_deleted_at: expect.any(Number),
      content_inline: null,
    });
    expect(deleted.journal).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "artifact.tombstoned",
          resource: uploaded.key,
        }),
      ]),
    );

    requests.length = 0;
    const after = `${root}/after.tila-backup`;
    const deletedManifest = await exportProjectBackup({
      source: endpoint,
      output: after,
    });
    expect(deletedManifest.stats.objects).toBe(1);
    expect(deletedManifest.stats.blob_bytes).toBe(0);
    expect(
      requests.filter(
        (url) =>
          url.searchParams.get("key") === uploaded.key &&
          (url.pathname.endsWith("/object-metadata") ||
            url.pathname.endsWith("/object")),
      ),
    ).toEqual([]);
    const inspection = await inspectProjectBackup(after);
    expect(inspection.manifest.complete).toBe(true);
    expect(
      inspection.entries.filter((entry) => entry.startsWith("blobs/")),
    ).toEqual([]);
    const deletedEntries = await readArchiveEntries(after);
    expect(
      JSON.parse(deletedEntries.get("objects.jsonl")?.toString().trim() ?? ""),
    ).toMatchObject({
      key: uploaded.key,
      tombstoned: true,
      blob_deleted: true,
      blob_path: null,
    });

    // Change the destination so a no-op import cannot satisfy the assertions.
    await artifacts.upload(
      new File([new Uint8Array([42])], "later.bin", {
        type: "application/octet-stream",
      }),
      { kind: "binary" },
    );
    expect((await snapshot()).pointers).toHaveLength(2);
    await importProjectBackup({
      archive: after,
      destination: endpoint,
      replace: true,
    });
    expect(await snapshot()).toEqual(deleted);
    expect(await bindings.ARTIFACTS.head(uploaded.key)).toBeNull();
    expect(await artifacts.meta(uploaded.key)).toMatchObject({
      pointer: {
        tombstoned: 1,
        blob_deleted_at: expect.any(Number),
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
