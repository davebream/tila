import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { projectTransferOps } from "@tila/ops-sqlite";
import {
  PROJECT_BACKUP_FORMAT,
  PROJECT_BACKUP_FORMAT_VERSION,
  type ProjectBackupEntry,
  ProjectBackupHeaderSchema,
  type ProjectBackupManifest,
  ProjectBackupManifestSchema,
  type ProjectBackupObject,
} from "@tila/schemas";
import * as tar from "tar-stream";
import { createNodeConnection } from "../local/connection";
import { SDK_VERSION } from "../version";

export const SUPPORTED_BACKUP_FEATURES = new Set<string>();
export const MAX_SUPPORTED_DO_MIGRATION = 24;

export type LocalBackupEndpoint = {
  backend: "local";
  projectId: string;
  dbPath: string;
  artifactsPath: string;
  productVersion?: string;
  schemaVersion?: number;
};

export type CloudBackupEndpoint = {
  backend: "cloud";
  projectId: string;
  baseUrl: string;
  token?: string;
  infraToken?: string;
  cloudflareAccountId?: string;
};

export type ProjectBackupSource = LocalBackupEndpoint | CloudBackupEndpoint;
export type ProjectBackupDestination =
  | LocalBackupEndpoint
  | CloudBackupEndpoint;

export type BackupProgress = {
  phase: "export" | "inspect" | "import";
  rows: number;
  bytes: number;
  elapsedMs: number;
};

export type ExportProjectBackupOptions = {
  source: ProjectBackupSource;
  output: string;
  onProgress?: (progress: BackupProgress) => void;
};

export type ImportProjectBackupOptions = {
  archive: string;
  destination: ProjectBackupDestination;
  replace?: boolean;
  resume?: boolean;
  rollback?: boolean;
  onProgress?: (progress: BackupProgress) => void;
};

export type InspectedProjectBackup = {
  header: ReturnType<typeof ProjectBackupHeaderSchema.parse>;
  manifest: ProjectBackupManifest;
  entries: string[];
};

const encoder = new TextEncoder();

function safeArchivePath(path: string): void {
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe backup entry path: ${JSON.stringify(path)}`);
  }
}

function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(`${projectTransferOps.canonicalJson(value)}\n`, "utf8");
}

function jsonlBuffer(rows: Record<string, unknown>[]): Buffer {
  if (rows.length === 0) return Buffer.alloc(0);
  return Buffer.from(
    `${rows.map((row) => projectTransferOps.canonicalJson(row)).join("\n")}\n`,
    "utf8",
  );
}

function digestBuffer(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  walk(root);
  return files.sort();
}

function contentRoot(entries: ProjectBackupEntry[]): string {
  const content = [...entries]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((entry) => projectTransferOps.canonicalJson(entry))
    .join("\n");
  return digestBuffer(encoder.encode(`${content}\n`));
}

async function addBuffer(
  pack: tar.Pack,
  entries: ProjectBackupEntry[],
  path: string,
  buffer: Buffer,
  rows?: number,
): Promise<void> {
  await new Promise<void>((resolveEntry, rejectEntry) => {
    pack.entry(
      { name: path, size: buffer.byteLength, mode: 0o600 },
      buffer,
      (error) => (error ? rejectEntry(error) : resolveEntry()),
    );
  });
  entries.push({
    path,
    bytes: buffer.byteLength,
    sha256: digestBuffer(buffer),
    ...(rows === undefined ? {} : { rows }),
  });
}

function ensureOutputAvailable(output: string): string {
  if (!resolve(output).startsWith(`${resolve(dirname(output))}${sep}`)) {
    throw new Error("Backup output path could not be resolved safely");
  }
  if (existsSync(output))
    throw new Error(`Refusing to overwrite existing backup: ${output}`);
  mkdirSync(dirname(output), { recursive: true });
  return `${output}.partial-${randomUUID()}`;
}

function createHashingTransform(expected: string): {
  transform: Transform;
  done: Promise<void>;
} {
  const hash = createHash("sha256");
  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveDone = resolvePromise;
    rejectDone = rejectPromise;
  });
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      const actual = hash.digest("hex");
      if (actual !== expected) {
        const error = new Error(
          `Blob checksum mismatch: expected ${expected}, got ${actual}`,
        );
        rejectDone(error);
        callback(error);
        return;
      }
      resolveDone();
      callback();
    },
  });
  return { transform, done };
}

async function exportLocal(
  options: ExportProjectBackupOptions & { source: LocalBackupEndpoint },
  control?: { sessionId: string; keepLock: boolean },
): Promise<ProjectBackupManifest> {
  const startedAt = Date.now();
  const temporary = ensureOutputAvailable(options.output);
  const { sql, close } = await createNodeConnection(options.source.dbPath, {
    skipFilesystemCheck: true,
  });
  const sessionId = control?.sessionId ?? randomUUID();
  const owner = `sdk:${process.pid}`;
  let finished = false;
  try {
    projectTransferOps.beginTransfer(sql, {
      sessionId,
      mode: "export",
      owner,
      ttlMs: 300_000,
    });
    const pack = tar.pack();
    const file = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
    const writing = pipeline(pack, file);
    const entries: ProjectBackupEntry[] = [];
    const createdAt = new Date().toISOString();
    const header = {
      format: PROJECT_BACKUP_FORMAT,
      format_version: PROJECT_BACKUP_FORMAT_VERSION,
      created_at: createdAt,
      project_id: options.source.projectId,
    } as const;
    await addBuffer(pack, entries, "header.json", jsonBuffer(header));

    let rowsTotal = 0;
    const pointerRows: Record<string, unknown>[] = [];
    for (const table of projectTransferOps.PROJECT_BACKUP_TABLES) {
      const rows: Record<string, unknown>[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const page = projectTransferOps.readSnapshotPage(sql, table, {
          offset,
          limit: 500,
        });
        rows.push(...page.rows);
        offset = page.nextOffset;
        projectTransferOps.renewExport(sql, sessionId, 300_000);
      }
      if (table === "artifact_pointers") pointerRows.push(...rows);
      rowsTotal += rows.length;
      await addBuffer(
        pack,
        entries,
        `do/${table}.jsonl`,
        jsonlBuffer(rows),
        rows.length,
      );
    }

    const d1Rows = [{ project_id: options.source.projectId, backend: "local" }];
    await addBuffer(pack, entries, "d1/project.jsonl", jsonlBuffer(d1Rows), 1);

    const objects: ProjectBackupObject[] = pointerRows.map((row) => {
      const deleted =
        row.blob_deleted_at !== null && row.blob_deleted_at !== undefined;
      return {
        key: String(row.r2_key),
        sha256: String(row.sha256),
        bytes: Number(row.bytes),
        blob_path: deleted ? null : `blobs/${String(row.sha256)}`,
        tombstoned: Number(row.tombstoned) === 1,
        blob_deleted: deleted,
        http_metadata: {},
        custom_metadata: {},
      };
    });
    const journal = projectTransferOps.journalState(sql);
    const archivedSequences = new Set<number>();
    const journalRoot = join(
      options.source.artifactsPath,
      "journal-archive",
      options.source.projectId,
    );
    for (const path of listFiles(journalRoot)) {
      const key = path
        .slice(resolve(options.source.artifactsPath).length + 1)
        .split(sep)
        .join("/");
      const bytes = statSync(path).size;
      const sha = await digestFile(path);
      for (const line of readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)) {
        const event = JSON.parse(line) as { seq: number };
        if (archivedSequences.has(event.seq))
          throw new Error(`Duplicate archived journal sequence ${event.seq}`);
        archivedSequences.add(event.seq);
      }
      objects.push({
        key,
        sha256: sha,
        bytes,
        blob_path: `blobs/${sha}`,
        tombstoned: false,
        blob_deleted: false,
        http_metadata: {},
        custom_metadata: {},
      });
    }
    for (let seq = 1; seq <= journal.archiveWatermark; seq += 1) {
      if (!archivedSequences.has(seq))
        throw new Error(
          `Archived journal coverage has a gap at sequence ${seq}`,
        );
    }
    if ([...archivedSequences].some((seq) => seq > journal.archiveWatermark)) {
      throw new Error(
        "Archived journal files contradict the confirmed watermark",
      );
    }
    await addBuffer(
      pack,
      entries,
      "objects.jsonl",
      jsonlBuffer(objects as unknown as Record<string, unknown>[]),
      objects.length,
    );

    let blobBytes = 0;
    const emitted = new Set<string>();
    for (const object of objects) {
      if (!object.blob_path || emitted.has(object.sha256)) continue;
      emitted.add(object.sha256);
      const blobFile = join(options.source.artifactsPath, object.key);
      if (!existsSync(blobFile))
        throw new Error(`Required blob is missing: ${object.key}`);
      const size = statSync(blobFile).size;
      if (size !== object.bytes)
        throw new Error(`Blob byte count mismatch for ${object.key}`);
      const target = pack.entry({ name: object.blob_path, size, mode: 0o600 });
      const { transform, done } = createHashingTransform(object.sha256);
      await pipeline(createReadStream(blobFile), transform, target);
      await done;
      entries.push({
        path: object.blob_path,
        bytes: size,
        sha256: object.sha256,
      });
      blobBytes += size;
      options.onProgress?.({
        phase: "export",
        rows: rowsTotal,
        bytes: blobBytes,
        elapsedMs: Date.now() - startedAt,
      });
    }

    const semantic = await projectTransferOps.semanticDigest(sql);
    const archiveBytesBeforeManifest = entries.reduce(
      (sum, entry) => sum + entry.bytes,
      0,
    );
    const manifest: ProjectBackupManifest = {
      format: PROJECT_BACKUP_FORMAT,
      format_version: PROJECT_BACKUP_FORMAT_VERSION,
      complete: true,
      project_id: options.source.projectId,
      created_at: createdAt,
      source: {
        backend: "local",
        product_version: options.source.productVersion ?? SDK_VERSION,
        do_migration_version: MAX_SUPPORTED_DO_MIGRATION,
        schema_version: options.source.schemaVersion ?? 1,
      },
      required_features: [],
      optional_sections: ["d1/project.jsonl"],
      entries,
      content_root: contentRoot(entries),
      semantic_digest: semantic,
      journal_next_sequence: journal.nextSequence,
      journal_archive_watermark: journal.archiveWatermark,
      exclusions: [
        "credentials",
        "bearer tokens and hashes",
        "sessions",
        "rate limits",
        "idempotency caches",
        "revoked JTIs and subjects",
        "migration and transfer bookkeeping",
        "unreferenced orphan blobs",
      ],
      stats: {
        rows: rowsTotal + 1,
        objects: objects.length,
        blob_bytes: blobBytes,
        archive_bytes: archiveBytesBeforeManifest,
        elapsed_ms: Date.now() - startedAt,
      },
    };
    await addBuffer(pack, [], "manifest.json", jsonBuffer(manifest));
    pack.finalize();
    await writing;

    await inspectProjectBackup(temporary);
    renameSync(temporary, options.output);
    if (!control?.keepLock) projectTransferOps.finishTransfer(sql, sessionId);
    finished = true;
    return {
      ...manifest,
      stats: {
        ...manifest.stats,
        archive_bytes: statSync(options.output).size,
        elapsed_ms: Date.now() - startedAt,
      },
    };
  } finally {
    if (!finished) rmSync(temporary, { force: true });
    close();
  }
}

export async function exportProjectBackup(
  options: ExportProjectBackupOptions,
): Promise<ProjectBackupManifest> {
  if (options.source.backend === "local")
    return exportLocal({ ...options, source: options.source });
  return exportCloud(options);
}

type SeenEntry = { path: string; sha256: string; bytes: number; rows?: number };

async function scanArchive(
  archive: string,
  captureData: boolean,
): Promise<{
  manifest: ProjectBackupManifest;
  header: ReturnType<typeof ProjectBackupHeaderSchema.parse>;
  seen: SeenEntry[];
  data: Map<string, Buffer>;
}> {
  const extract = tar.extract();
  const seen: SeenEntry[] = [];
  const paths = new Set<string>();
  const data = new Map<string, Buffer>();
  let lastPath = "";
  let failure: Error | null = null;
  let headerValue: unknown;
  let manifestValue: unknown;
  extract.on("entry", (header, stream, next) => {
    const path = header.name;
    try {
      safeArchivePath(path);
      if (paths.has(path)) throw new Error(`Duplicate backup entry: ${path}`);
      paths.add(path);
      lastPath = path;
    } catch (error) {
      failure = error as Error;
      stream.resume();
      next();
      return;
    }
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    let bytes = 0;
    let rows = 0;
    let previous = 10;
    stream.on("data", (value: unknown) => {
      const chunk = Buffer.isBuffer(value)
        ? value
        : Buffer.from(value as Uint8Array);
      hash.update(chunk);
      bytes += chunk.byteLength;
      if (path.endsWith(".jsonl")) {
        for (const byte of chunk) if (byte === 10) rows += 1;
        previous = chunk.at(-1) ?? previous;
      }
      if (
        (captureData && !path.startsWith("blobs/")) ||
        path === "header.json" ||
        path === "manifest.json"
      ) {
        chunks.push(Buffer.from(chunk));
      }
    });
    stream.on("end", () => {
      try {
        if (path.endsWith(".jsonl") && bytes > 0 && previous !== 10) rows += 1;
        const buffer = Buffer.concat(chunks);
        if (captureData) data.set(path, buffer);
        if (path === "header.json")
          headerValue = JSON.parse(buffer.toString("utf8"));
        if (path === "manifest.json")
          manifestValue = JSON.parse(buffer.toString("utf8"));
        else
          seen.push({
            path,
            sha256: hash.digest("hex"),
            bytes,
            ...(path.endsWith(".jsonl") ? { rows } : {}),
          });
      } catch (error) {
        failure = error as Error;
      }
      next();
    });
    stream.on("error", (error) => {
      failure = error;
    });
  });
  await pipeline(createReadStream(archive), extract);
  if (failure) throw failure;
  if (lastPath !== "manifest.json" || manifestValue === undefined) {
    throw new Error(
      "Backup is incomplete or truncated: final manifest.json is missing",
    );
  }
  const header = ProjectBackupHeaderSchema.parse(headerValue);
  const manifest = ProjectBackupManifestSchema.parse(manifestValue);
  if (header.project_id !== manifest.project_id)
    throw new Error("Backup project IDs disagree");
  if (manifest.source.do_migration_version > MAX_SUPPORTED_DO_MIGRATION) {
    throw new Error(
      `Backup requires unsupported DO migration ${manifest.source.do_migration_version}`,
    );
  }
  const unknown = manifest.required_features.filter(
    (feature) => !SUPPORTED_BACKUP_FEATURES.has(feature),
  );
  if (unknown.length > 0)
    throw new Error(`Backup requires unknown features: ${unknown.join(", ")}`);
  const expected = new Map(
    manifest.entries.map((entry) => [entry.path, entry]),
  );
  if (expected.size !== manifest.entries.length)
    throw new Error("Manifest contains duplicate entry paths");
  for (const actual of seen) {
    const declared = expected.get(actual.path);
    if (!declared)
      throw new Error(
        `Archive entry is not declared by manifest: ${actual.path}`,
      );
    if (
      declared.sha256 !== actual.sha256 ||
      declared.bytes !== actual.bytes ||
      declared.rows !== actual.rows
    ) {
      throw new Error(
        `Checksum, byte count, or row count mismatch for ${actual.path}`,
      );
    }
    expected.delete(actual.path);
  }
  if (expected.size > 0)
    throw new Error(
      `Manifest entries are missing: ${[...expected.keys()].join(", ")}`,
    );
  if (contentRoot(manifest.entries) !== manifest.content_root)
    throw new Error("Backup content-root digest mismatch");
  return { manifest, header, seen, data };
}

export async function inspectProjectBackup(
  archive: string,
): Promise<InspectedProjectBackup> {
  const scanned = await scanArchive(archive, false);
  return {
    header: scanned.header,
    manifest: scanned.manifest,
    entries: scanned.seen.map(({ path }) => path),
  };
}

function parseJsonl(buffer: Buffer | undefined): Record<string, unknown>[] {
  if (!buffer || buffer.byteLength === 0) return [];
  return buffer
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function extractLocalArchive(
  archive: string,
  dbPath: string,
  artifactsPath: string,
  manifest: ProjectBackupManifest,
): Promise<void> {
  const scanned = await scanArchive(archive, true);
  const connection = await createNodeConnection(dbPath, {
    skipFilesystemCheck: true,
  });
  try {
    const tables: Partial<
      Record<
        (typeof projectTransferOps.PROJECT_BACKUP_TABLES)[number],
        Record<string, unknown>[]
      >
    > = {};
    for (const table of projectTransferOps.PROJECT_BACKUP_TABLES) {
      tables[table] = parseJsonl(scanned.data.get(`do/${table}.jsonl`));
    }
    projectTransferOps.replaceSnapshotRows(
      connection.sql,
      tables,
      manifest.journal_next_sequence,
    );
    const digest = await projectTransferOps.semanticDigest(connection.sql);
    if (digest !== manifest.semantic_digest)
      throw new Error(
        "Restored SQLite semantic digest does not match the backup",
      );
  } finally {
    connection.close();
  }
  const objects = parseJsonl(
    scanned.data.get("objects.jsonl"),
  ) as unknown as ProjectBackupObject[];
  const spoolRoot = `${artifactsPath}.backup-blobs`;
  await mkdir(spoolRoot, { recursive: true });
  const extract = tar.extract();
  let extractionFailure: Error | null = null;
  extract.on("entry", (header, stream, next) => {
    if (!header.name.startsWith("blobs/")) {
      stream.resume();
      stream.on("end", next);
      return;
    }
    const sha = header.name.slice("blobs/".length);
    const target = join(spoolRoot, sha);
    pipeline(stream, createWriteStream(target, { flags: "wx", mode: 0o600 }))
      .then(() => next())
      .catch((error: Error) => {
        extractionFailure = error;
        next(error);
      });
  });
  await pipeline(createReadStream(archive), extract);
  if (extractionFailure) throw extractionFailure;
  for (const object of objects) {
    if (!object.blob_path) continue;
    const blob = join(spoolRoot, object.sha256);
    if (!existsSync(blob))
      throw new Error(`Required backup blob is missing: ${object.blob_path}`);
    const target = resolve(artifactsPath, object.key);
    const root = resolve(artifactsPath);
    if (!target.startsWith(`${root}${sep}`))
      throw new Error(`Artifact key escapes destination: ${object.key}`);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.partial-${randomUUID()}`;
    await copyFile(blob, temporary);
    await rename(temporary, target);
  }
  await rm(spoolRoot, { recursive: true, force: true });
}

function safetyPath(archive: string, projectId: string): string {
  const stamp = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d{3}Z$/, "Z")
    .toLowerCase();
  return join(
    dirname(archive),
    `${stamp}-${projectId}-pre-restore.tila-backup`,
  );
}

async function importLocal(
  options: ImportProjectBackupOptions & { destination: LocalBackupEndpoint },
): Promise<{ manifest: ProjectBackupManifest; safetyBackup?: string }> {
  const inspected = await inspectProjectBackup(options.archive);
  if (inspected.manifest.project_id !== options.destination.projectId) {
    throw new Error(
      "Project renaming is unsupported; destination project ID must match the backup",
    );
  }
  const exists = existsSync(options.destination.dbPath);
  if (exists && !options.replace && !options.resume && !options.rollback) {
    throw new Error(
      "Destination exists; pass replace to run the guarded restore workflow",
    );
  }
  let safetyBackup: string | undefined;
  const sessionId = randomUUID();
  if (exists && !options.resume && !options.rollback) {
    safetyBackup = safetyPath(options.archive, options.destination.projectId);
    await exportLocal(
      {
        source: options.destination,
        output: safetyBackup,
        onProgress: options.onProgress,
      },
      { sessionId, keepLock: true },
    );
    const original = await createNodeConnection(options.destination.dbPath, {
      skipFilesystemCheck: true,
    });
    try {
      projectTransferOps.promoteTransfer(
        original.sql,
        sessionId,
        "import",
        inspected.manifest.content_root,
        safetyBackup,
      );
    } finally {
      original.close();
    }
  } else if (exists && (options.resume || options.rollback)) {
    const original = await createNodeConnection(options.destination.dbPath, {
      skipFilesystemCheck: true,
    });
    try {
      const state = projectTransferOps.getTransferState(original.sql);
      if (!state || state.mode === "export")
        throw new Error("No interrupted local restore is available");
      if (
        options.resume &&
        state.archive_digest !== inspected.manifest.content_root
      ) {
        throw new Error(
          "Interrupted local restore belongs to a different archive",
        );
      }
      if (options.rollback) {
        projectTransferOps.retargetTransfer(
          original.sql,
          state.session_id,
          inspected.manifest.content_root,
        );
      }
    } finally {
      original.close();
    }
  }
  const stageId = randomUUID();
  const stageDb = `${options.destination.dbPath}.restore-${stageId}`;
  const stageArtifacts = `${options.destination.artifactsPath}.restore-${stageId}`;
  try {
    mkdirSync(dirname(stageDb), { recursive: true });
    mkdirSync(stageArtifacts, { recursive: true });
    await extractLocalArchive(
      options.archive,
      stageDb,
      stageArtifacts,
      inspected.manifest,
    );
    if (exists) {
      const oldDb = `${options.destination.dbPath}.swap-old-${stageId}`;
      const oldArtifacts = `${options.destination.artifactsPath}.swap-old-${stageId}`;
      renameSync(options.destination.dbPath, oldDb);
      try {
        renameSync(stageDb, options.destination.dbPath);
        if (existsSync(options.destination.artifactsPath))
          renameSync(options.destination.artifactsPath, oldArtifacts);
        renameSync(stageArtifacts, options.destination.artifactsPath);
      } catch (error) {
        if (!existsSync(options.destination.dbPath) && existsSync(oldDb))
          renameSync(oldDb, options.destination.dbPath);
        if (
          !existsSync(options.destination.artifactsPath) &&
          existsSync(oldArtifacts)
        )
          renameSync(oldArtifacts, options.destination.artifactsPath);
        throw error;
      }
      rmSync(oldDb, { force: true });
      rmSync(oldArtifacts, { recursive: true, force: true });
    } else {
      renameSync(stageDb, options.destination.dbPath);
      renameSync(stageArtifacts, options.destination.artifactsPath);
    }
    return {
      manifest: inspected.manifest,
      ...(safetyBackup ? { safetyBackup } : {}),
    };
  } finally {
    await rm(stageDb, { force: true });
    await rm(stageArtifacts, { recursive: true, force: true });
  }
}

export async function importProjectBackup(
  options: ImportProjectBackupOptions,
): Promise<{
  manifest: ProjectBackupManifest;
  safetyBackup?: string;
  bootstrapToken?: string;
}> {
  if (options.destination.backend === "local")
    return importLocal({ ...options, destination: options.destination });
  return importCloud(options);
}

export class TilaOperatorClient {
  constructor(private readonly endpoint: CloudBackupEndpoint) {}

  private prefix(): string {
    if (this.endpoint.infraToken) {
      return `/_internal/admin/projects/${encodeURIComponent(this.endpoint.projectId)}/backup`;
    }
    return `/projects/${encodeURIComponent(this.endpoint.projectId)}/admin/backup`;
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const token = this.endpoint.infraToken ?? this.endpoint.token;
    if (!token) throw new Error("Cloud backup requires a token or infraToken");
    const response = await fetch(
      `${this.endpoint.baseUrl.replace(/\/$/, "")}${this.prefix()}${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.method && init.method !== "GET"
            ? { "X-Confirm-Slug": this.endpoint.projectId }
            : {}),
          ...(init.headers ?? {}),
        },
      },
    );
    if (!response.ok)
      throw new Error(
        `Backup operator request failed (${response.status}): ${await response.text()}`,
      );
    return response;
  }

  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    return (await (await this.request(path, init)).json()) as T;
  }
}

async function exportCloud(
  options: ExportProjectBackupOptions,
  control?: { sessionId: string; keepLock: boolean },
): Promise<ProjectBackupManifest> {
  const source = options.source as CloudBackupEndpoint;
  const startedAt = Date.now();
  const temporary = ensureOutputAvailable(options.output);
  const client = new TilaOperatorClient(source);
  const sessionId = control?.sessionId ?? randomUUID();
  let completed = false;
  try {
    await client.json("/transfer/begin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        mode: "export",
        owner: "sdk",
        ttlMs: 300_000,
      }),
    });
    const pack = tar.pack();
    const writing = pipeline(
      pack,
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    const entries: ProjectBackupEntry[] = [];
    const createdAt = new Date().toISOString();
    await addBuffer(
      pack,
      entries,
      "header.json",
      jsonBuffer({
        format: PROJECT_BACKUP_FORMAT,
        format_version: PROJECT_BACKUP_FORMAT_VERSION,
        created_at: createdAt,
        project_id: source.projectId,
      }),
    );

    const meta = await client.json<{
      digest: string;
      journal: { nextSequence: number; archiveWatermark: number };
      migrationVersion: number;
      tables: (typeof projectTransferOps.PROJECT_BACKUP_TABLES)[number][];
    }>(`/transfer/meta?sessionId=${encodeURIComponent(sessionId)}`);
    let rowsTotal = 0;
    const pointerRows: Record<string, unknown>[] = [];
    for (const table of meta.tables) {
      const rows: Record<string, unknown>[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const page: {
          rows: Record<string, unknown>[];
          nextOffset: number | null;
        } = await client.json(
          `/transfer/snapshot/${table}?sessionId=${encodeURIComponent(sessionId)}&offset=${offset}&limit=500`,
        );
        rows.push(...page.rows);
        offset = page.nextOffset;
        await client.json("/transfer/renew", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, ttlMs: 300_000 }),
        });
      }
      if (table === "artifact_pointers") pointerRows.push(...rows);
      rowsTotal += rows.length;
      await addBuffer(
        pack,
        entries,
        `do/${table}.jsonl`,
        jsonlBuffer(rows),
        rows.length,
      );
    }
    const d1 = await client.json<{
      sections: Record<string, Record<string, unknown>[]>;
    }>(`/d1?sessionId=${encodeURIComponent(sessionId)}`);
    const d1Digest = digestBuffer(
      encoder.encode(projectTransferOps.canonicalJson(d1.sections)),
    );
    for (const [table, rows] of Object.entries(d1.sections).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      rowsTotal += rows.length;
      await addBuffer(
        pack,
        entries,
        `d1/${table}.jsonl`,
        jsonlBuffer(rows),
        rows.length,
      );
    }

    const objects: ProjectBackupObject[] = [];
    for (const row of pointerRows) {
      const deleted =
        row.blob_deleted_at !== null && row.blob_deleted_at !== undefined;
      const key = String(row.r2_key);
      let httpMetadata: Record<string, unknown> = {};
      let customMetadata: Record<string, string> = {};
      if (!deleted) {
        const metadata = await client.json<{
          httpMetadata: Record<string, unknown>;
          customMetadata: Record<string, string>;
          bytes: number;
        }>(
          `/object-metadata?sessionId=${encodeURIComponent(sessionId)}&key=${encodeURIComponent(key)}`,
        );
        if (metadata.bytes !== Number(row.bytes))
          throw new Error(`Blob byte count mismatch for ${key}`);
        httpMetadata = metadata.httpMetadata;
        customMetadata = metadata.customMetadata;
      }
      objects.push({
        key,
        sha256: String(row.sha256),
        bytes: Number(row.bytes),
        blob_path: deleted ? null : `blobs/${String(row.sha256)}`,
        tombstoned: Number(row.tombstoned) === 1,
        blob_deleted: deleted,
        http_metadata: httpMetadata,
        custom_metadata: customMetadata,
      });
    }
    const archives = await client.json<{
      objects: Array<{
        key: string;
        bytes: number;
        customMetadata: Record<string, string>;
      }>;
    }>(`/journal-archives?sessionId=${encodeURIComponent(sessionId)}`);
    const archivedSequences = new Set<number>();
    for (const archiveObject of archives.objects) {
      const response = await client.request(
        `/object?sessionId=${encodeURIComponent(sessionId)}&key=${encodeURIComponent(archiveObject.key)}`,
      );
      const text = await response.text();
      const bytes = Buffer.from(text, "utf8");
      const sha = digestBuffer(bytes);
      for (const line of text.split("\n").filter(Boolean)) {
        const event = JSON.parse(line) as { seq: number };
        if (archivedSequences.has(event.seq))
          throw new Error(`Duplicate archived journal sequence ${event.seq}`);
        archivedSequences.add(event.seq);
      }
      objects.push({
        key: archiveObject.key,
        sha256: sha,
        bytes: bytes.byteLength,
        blob_path: `blobs/${sha}`,
        tombstoned: false,
        blob_deleted: false,
        http_metadata: {},
        custom_metadata: archiveObject.customMetadata,
      });
    }
    for (let seq = 1; seq <= meta.journal.archiveWatermark; seq += 1) {
      if (!archivedSequences.has(seq))
        throw new Error(
          `Archived journal coverage has a gap at sequence ${seq}`,
        );
    }
    if (
      [...archivedSequences].some((seq) => seq > meta.journal.archiveWatermark)
    ) {
      throw new Error(
        "Archived journal objects contradict the confirmed watermark",
      );
    }
    await addBuffer(
      pack,
      entries,
      "objects.jsonl",
      jsonlBuffer(objects as unknown as Record<string, unknown>[]),
      objects.length,
    );

    let blobBytes = 0;
    const emitted = new Set<string>();
    for (const object of objects) {
      if (!object.blob_path || emitted.has(object.sha256)) continue;
      emitted.add(object.sha256);
      const response = await client.request(
        `/object?sessionId=${encodeURIComponent(sessionId)}&key=${encodeURIComponent(object.key)}`,
      );
      if (!response.body)
        throw new Error(`Required blob is missing: ${object.key}`);
      const target = pack.entry({
        name: object.blob_path,
        size: object.bytes,
        mode: 0o600,
      });
      const { transform, done } = createHashingTransform(object.sha256);
      await pipeline(
        Readable.fromWeb(response.body as never),
        transform,
        target,
      );
      await done;
      entries.push({
        path: object.blob_path,
        bytes: object.bytes,
        sha256: object.sha256,
      });
      blobBytes += object.bytes;
      options.onProgress?.({
        phase: "export",
        rows: rowsTotal,
        bytes: blobBytes,
        elapsedMs: Date.now() - startedAt,
      });
    }
    const d1After = await client.json<{
      sections: Record<string, Record<string, unknown>[]>;
    }>(`/d1?sessionId=${encodeURIComponent(sessionId)}`);
    const d1AfterDigest = digestBuffer(
      encoder.encode(projectTransferOps.canonicalJson(d1After.sections)),
    );
    if (d1AfterDigest !== d1Digest)
      throw new Error("D1 ACL metadata changed during export");
    const manifest: ProjectBackupManifest = {
      format: PROJECT_BACKUP_FORMAT,
      format_version: PROJECT_BACKUP_FORMAT_VERSION,
      complete: true,
      project_id: source.projectId,
      created_at: createdAt,
      source: {
        backend: "cloud",
        product_version: SDK_VERSION,
        do_migration_version: meta.migrationVersion,
        schema_version: Number(d1.sections._projects?.[0]?.schema_version ?? 1),
        ...((source.cloudflareAccountId ??
        d1.sections._projects?.[0]?.cloudflare_account_id)
          ? {
              cloudflare_account_id: String(
                source.cloudflareAccountId ??
                  d1.sections._projects?.[0]?.cloudflare_account_id,
              ),
            }
          : {}),
        ...(d1.sections._github_app_config?.[0]?.installation_id
          ? {
              github_installation_id: String(
                d1.sections._github_app_config[0].installation_id,
              ),
            }
          : {}),
      },
      required_features: [],
      optional_sections: [],
      entries,
      content_root: contentRoot(entries),
      semantic_digest: meta.digest,
      journal_next_sequence: meta.journal.nextSequence,
      journal_archive_watermark: meta.journal.archiveWatermark,
      exclusions: [
        "bearer tokens and hashes",
        "sessions",
        "rate limits",
        "idempotency caches",
        "revoked JTIs and subjects",
        "deployment-global metadata",
        "migration and transfer bookkeeping",
        "unreferenced orphan blobs",
      ],
      stats: {
        rows: rowsTotal,
        objects: objects.length,
        blob_bytes: blobBytes,
        archive_bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
        elapsed_ms: Date.now() - startedAt,
      },
    };
    await addBuffer(pack, [], "manifest.json", jsonBuffer(manifest));
    pack.finalize();
    await writing;
    await inspectProjectBackup(temporary);
    renameSync(temporary, options.output);
    if (!control?.keepLock) {
      await client.json("/transfer/complete-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
    }
    completed = true;
    return {
      ...manifest,
      stats: {
        ...manifest.stats,
        archive_bytes: statSync(options.output).size,
        elapsed_ms: Date.now() - startedAt,
      },
    };
  } finally {
    if (!completed) rmSync(temporary, { force: true });
  }
}

async function importCloud(options: ImportProjectBackupOptions): Promise<{
  manifest: ProjectBackupManifest;
  safetyBackup?: string;
  bootstrapToken?: string;
}> {
  const destination = options.destination as CloudBackupEndpoint;
  const inspected = await inspectProjectBackup(options.archive);
  if (inspected.manifest.project_id !== destination.projectId) {
    throw new Error(
      "Project renaming is unsupported; destination project ID must match the backup",
    );
  }
  let safetyBackup: string | undefined;
  let sessionId: string = randomUUID();
  const client = new TilaOperatorClient(destination);
  let newProject = false;
  if (destination.infraToken && !options.resume && !options.rollback) {
    const bootstrap = await client.json<{ created: boolean }>("/bootstrap", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Confirm-Slug": destination.projectId,
      },
      body: JSON.stringify({
        cloudflareAccountId: destination.cloudflareAccountId,
        schemaVersion: inspected.manifest.source.schema_version,
      }),
    });
    newProject = bootstrap.created;
  }
  if (options.replace && !options.resume && !options.rollback) {
    safetyBackup = safetyPath(options.archive, destination.projectId);
    await exportCloud(
      {
        source: destination,
        output: safetyBackup,
        onProgress: options.onProgress,
      },
      { sessionId, keepLock: true },
    );
    await client.json("/transfer/promote", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Confirm-Slug": destination.projectId,
      },
      body: JSON.stringify({
        sessionId,
        mode: "import",
        archiveDigest: inspected.manifest.content_root,
        safetyArchive: safetyBackup,
      }),
    });
  }
  const mode = options.rollback ? "rollback" : "import";
  if (options.rollback) {
    const status = await client.json<{
      state: { session_id: string; mode: string } | null;
    }>("/transfer/status");
    if (!status.state || status.state.mode === "export") {
      throw new Error("No failed restore session is available to roll back");
    }
    sessionId = status.state.session_id;
    await client.json("/transfer/retarget", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Confirm-Slug": destination.projectId,
      },
      body: JSON.stringify({
        sessionId,
        archiveDigest: inspected.manifest.content_root,
      }),
    });
  } else if (options.resume) {
    const status = await client.json<{
      state: {
        session_id: string;
        archive_digest: string | null;
        mode: string;
      } | null;
    }>("/transfer/status");
    if (
      !status.state ||
      status.state.archive_digest !== inspected.manifest.content_root ||
      status.state.mode === "export"
    ) {
      throw new Error(
        "No matching interrupted restore session is available to resume",
      );
    }
    sessionId = status.state.session_id;
  } else if (!safetyBackup) {
    await client.json("/transfer/begin", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Confirm-Slug": destination.projectId,
      },
      body: JSON.stringify({
        sessionId,
        mode,
        owner: "sdk",
        archiveDigest: inspected.manifest.content_root,
        safetyArchive: safetyBackup,
      }),
    });
  }
  const scanned = await scanArchive(options.archive, true);
  const objects = parseJsonl(
    scanned.data.get("objects.jsonl"),
  ) as unknown as ProjectBackupObject[];
  const spoolRoot = `${options.archive}.restore-${sessionId}`;
  await mkdir(spoolRoot, { recursive: true });
  try {
    const extract = tar.extract();
    extract.on("entry", (header, stream, next) => {
      if (!header.name.startsWith("blobs/")) {
        stream.resume();
        stream.on("end", next);
        return;
      }
      pipeline(
        stream,
        createWriteStream(join(spoolRoot, header.name.slice(6)), {
          flags: "wx",
          mode: 0o600,
        }),
      )
        .then(() => next())
        .catch(next);
    });
    await pipeline(createReadStream(options.archive), extract);
    for (const object of objects) {
      if (!object.blob_path) continue;
      const response = await client.request(
        `/object?sessionId=${encodeURIComponent(sessionId)}&key=${encodeURIComponent(object.key)}&sha256=${object.sha256}`,
        {
          method: "PUT",
          headers: {
            "Content-Length": String(object.bytes),
            "X-Tila-Custom-Metadata": JSON.stringify(object.custom_metadata),
            "X-Tila-Http-Metadata": JSON.stringify(object.http_metadata),
          },
          body: Readable.toWeb(
            createReadStream(join(spoolRoot, object.sha256)),
          ) as never,
          duplex: "half",
        } as RequestInit,
      );
      await response.body?.cancel();
    }
    await client.json("/transfer/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    for (const table of projectTransferOps.PROJECT_BACKUP_TABLES) {
      const rows = parseJsonl(scanned.data.get(`do/${table}.jsonl`));
      const chunkSize = 250;
      for (let index = 0; index * chunkSize < rows.length; index += 1) {
        const chunk = rows.slice(index * chunkSize, (index + 1) * chunkSize);
        const bytes = jsonlBuffer(chunk);
        await client.json(`/transfer/rows/${table}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            chunkIndex: index,
            sha256: digestBuffer(bytes),
            rows: chunk,
          }),
        });
      }
    }
    const sections: Record<string, Record<string, unknown>[]> = {};
    for (const [path, buffer] of scanned.data) {
      if (path.startsWith("d1/") && path.endsWith(".jsonl")) {
        sections[path.slice(3, -6)] = parseJsonl(buffer);
      }
    }
    sections._projects ??= [
      {
        project_id: destination.projectId,
        display_name: destination.projectId,
        schema_version: inspected.manifest.source.schema_version,
        archived: 0,
      },
    ];
    const d1Result = await client.json<{ bootstrapToken?: string }>(
      "/d1/restore",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Confirm-Slug": destination.projectId,
        },
        body: JSON.stringify({
          sessionId,
          sections,
          createBootstrapToken: newProject,
        }),
      },
    );
    await client.json("/transfer/finalize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        journalNextSequence: inspected.manifest.journal_next_sequence,
        semanticDigest: inspected.manifest.semantic_digest,
      }),
    });
    return {
      manifest: inspected.manifest,
      ...(safetyBackup ? { safetyBackup } : {}),
      ...(d1Result.bootstrapToken
        ? { bootstrapToken: d1Result.bootstrapToken }
        : {}),
    };
  } finally {
    await rm(spoolRoot, { recursive: true, force: true });
  }
}
