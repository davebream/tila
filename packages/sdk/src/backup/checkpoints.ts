import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  type ProjectCheckpoint,
  ProjectCheckpointSchema,
  type ProjectRecoveryContext,
  ProjectRecoveryContextSchema,
} from "@tila/schemas";
import { z } from "zod";
import {
  type CloudBackupEndpoint,
  TilaOperatorClient,
  exportProjectBackup,
  importProjectBackup,
  inspectProjectBackup,
} from "./index";

export function checkpointInstance(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash)
    throw new Error(
      "Checkpoint instance URL must not contain credentials, query, or fragment",
    );
  return url.href.replace(/\/$/, "");
}

export function checkpointTime(value: string): string {
  const parsed = z.string().datetime({ offset: true }).safeParse(value);
  if (!parsed.success)
    throw new Error(
      "--to must be an ISO-8601 timestamp with an explicit timezone",
    );
  return new Date(parsed.data).toISOString();
}

function directoryPath(directory: string): void {
  if (!isAbsolute(directory))
    throw new Error("--directory must be an absolute path");
}

async function capabilities(source: CloudBackupEndpoint) {
  if (!source.infraToken)
    throw new Error(
      "Checkpoint recovery requires an infrastructure-owner token",
    );
  const result = await new TilaOperatorClient(source).json<{
    recovery: string;
    projectId: string;
    accountId: string;
  }>("/capabilities");
  if (
    result.recovery !== "preserve-current-access-v1" ||
    result.projectId !== source.projectId ||
    !result.accountId
  )
    throw new Error(
      "Worker does not support checkpoint recovery; upgrade the Worker first",
    );
  if (
    source.cloudflareAccountId &&
    source.cloudflareAccountId !== result.accountId
  )
    throw new Error("Checkpoint account does not match the configured account");
  return result;
}

function assertTarget(
  checkpoint: ProjectCheckpoint,
  source: CloudBackupEndpoint,
  accountId: string,
): void {
  if (
    checkpoint.project_id !== source.projectId ||
    checkpoint.instance !== checkpointInstance(source.baseUrl) ||
    checkpoint.account_id !== accountId
  )
    throw new Error(
      "Checkpoint belongs to a different project, instance, or account",
    );
}

export type CheckpointListing = {
  archive: string;
  checkpoint?: ProjectCheckpoint;
  content_root?: string;
  error?: string;
  legacy?: boolean;
};

/** No recursion: safety archives and operations are deliberately excluded. */
export async function listProjectCheckpoints(options: {
  directory: string;
}): Promise<CheckpointListing[]> {
  directoryPath(options.directory);
  const result: CheckpointListing[] = [];
  for (const file of (
    await readdir(options.directory, { withFileTypes: true })
  ).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!file.name.includes(".tila-backup")) continue;
    const archive = join(options.directory, file.name);
    try {
      if (!file.isFile() || !file.name.endsWith(".tila-backup"))
        throw new Error("Incomplete or non-regular checkpoint archive");
      const inspected = await inspectProjectBackup(archive);
      if (!inspected.checkpoint) {
        result.push({ archive, legacy: true });
        continue;
      }
      if (
        inspected.checkpoint.project_id !== inspected.manifest.project_id ||
        inspected.manifest.source.backend !== "cloud" ||
        inspected.checkpoint.account_id !==
          inspected.manifest.source.cloudflare_account_id
      )
        throw new Error("Checkpoint metadata disagrees with its archive");
      result.push({
        archive,
        checkpoint: inspected.checkpoint,
        content_root: inspected.manifest.content_root,
      });
    } catch (error) {
      result.push({
        archive,
        error: error instanceof Error ? error.message : "Invalid checkpoint",
      });
    }
  }
  return result;
}

export async function createProjectCheckpoint(options: {
  source: CloudBackupEndpoint;
  directory: string;
}) {
  directoryPath(options.directory);
  const target = await capabilities(options.source);
  const id = randomUUID();
  const archive = join(options.directory, `${id}.tila-backup`);
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  await exportProjectBackup({
    source: options.source,
    output: archive,
    checkpoint: {
      version: 1,
      id,
      project_id: options.source.projectId,
      instance: checkpointInstance(options.source.baseUrl),
      account_id: target.accountId,
    },
  });
  const inspected = await inspectProjectBackup(archive);
  if (!inspected.checkpoint) throw new Error("Checkpoint metadata is missing");
  return {
    archive,
    checkpoint: inspected.checkpoint,
    content_root: inspected.manifest.content_root,
  };
}

export async function selectProjectCheckpoint(options: {
  source: CloudBackupEndpoint;
  directory: string;
  to: string;
}) {
  const requestedAt = checkpointTime(options.to);
  const target = await capabilities(options.source);
  const entries = await listProjectCheckpoints(options);
  const candidates: (CheckpointListing & {
    checkpoint: ProjectCheckpoint;
    content_root: string;
  })[] = [];
  for (const entry of entries) {
    if (entry.error)
      throw new Error(
        `Cannot select recovery point: ${entry.archive}: ${entry.error}`,
      );
    if (!entry.checkpoint || !entry.content_root) continue;
    assertTarget(entry.checkpoint, options.source, target.accountId);
    if (Date.parse(entry.checkpoint.snapshot_at) <= Date.parse(requestedAt))
      candidates.push({
        ...entry,
        checkpoint: entry.checkpoint,
        content_root: entry.content_root,
      });
  }
  candidates.sort(
    (a, b) =>
      Date.parse(b.checkpoint.snapshot_at) -
        Date.parse(a.checkpoint.snapshot_at) ||
      b.checkpoint.id.localeCompare(a.checkpoint.id),
  );
  const selected = candidates[0];
  if (!selected)
    throw new Error(
      "No verified checkpoint exists at or before the requested time",
    );
  return { ...selected, requested_at: requestedAt };
}

const OperationSchema = z.object({
  version: z.literal(1),
  operation_id: z.string().uuid(),
  directory: z.string(),
  archive: z.string(),
  safety_backup: z.string(),
  requested_at: z.string().datetime(),
  checkpoint: ProjectCheckpointSchema,
  archive_digest: ProjectRecoveryContextSchema.shape.archive_digest,
});
type Operation = z.infer<typeof OperationSchema>;
export type ProjectRecoveryPlan = Operation & {
  action: "restore" | "resume" | "rollback";
};

function operationPath(directory: string, id: string) {
  z.string().uuid().parse(id);
  return join(directory, ".safety", `${id}.json`);
}

export async function planProjectRecovery(options: {
  source: CloudBackupEndpoint;
  directory: string;
  to?: string;
  resume?: string;
  rollback?: string;
}): Promise<ProjectRecoveryPlan> {
  directoryPath(options.directory);
  if (
    [options.to, options.resume, options.rollback].filter(Boolean).length !== 1
  )
    throw new Error(
      "Provide exactly one of --to, --resume <operation-id>, or --rollback <operation-id>",
    );
  if (options.to) {
    const selected = await selectProjectCheckpoint({
      ...options,
      to: options.to,
    });
    const id = randomUUID();
    return {
      version: 1,
      operation_id: id,
      directory: options.directory,
      archive: selected.archive,
      safety_backup: join(options.directory, ".safety", `${id}.tila-backup`),
      requested_at: selected.requested_at,
      checkpoint: selected.checkpoint,
      archive_digest: selected.content_root,
      action: "restore",
    };
  }
  const id = options.resume ?? options.rollback;
  if (!id) throw new Error("Operation ID is required");
  const operation = OperationSchema.parse(
    JSON.parse(await readFile(operationPath(options.directory, id), "utf8")),
  );
  if (
    operation.operation_id !== id ||
    operation.directory !== options.directory ||
    operation.safety_backup !==
      join(options.directory, ".safety", `${id}.tila-backup`)
  )
    throw new Error("Recovery operation metadata does not match its location");
  const target = await capabilities(options.source);
  assertTarget(operation.checkpoint, options.source, target.accountId);
  return { ...operation, action: options.rollback ? "rollback" : "resume" };
}

/** Executes precisely the reviewed plan; never resolves the timestamp again. */
export async function restoreProjectCheckpoint(options: {
  source: CloudBackupEndpoint;
  plan: ProjectRecoveryPlan;
}) {
  const { source, plan } = options;
  const operation = OperationSchema.parse(plan);
  directoryPath(operation.directory);
  const target = await capabilities(source);
  assertTarget(operation.checkpoint, source, target.accountId);
  const client = new TilaOperatorClient(source);
  const expectedMode = plan.action === "rollback" ? "rollback" : "import";
  const result = {
    ok: true,
    ...operation,
    actual_time: operation.checkpoint.snapshot_at as string | null,
    mode: expectedMode,
  };
  const completed = await client.json<{
    receipt: { mode: string; context: string } | null;
  }>(`/recovery/${operation.operation_id}`);
  if (completed.receipt) {
    const saved = ProjectRecoveryContextSchema.parse(
      JSON.parse(completed.receipt.context),
    );
    if (
      saved.archive_digest !== operation.archive_digest ||
      completed.receipt.mode !== expectedMode
    )
      throw new Error(
        "Operation already completed with a different recovery action",
      );
    if (expectedMode === "rollback")
      result.actual_time = saved.safety_snapshot_at ?? null;
    return result;
  }
  const archive =
    plan.action === "rollback" ? operation.safety_backup : operation.archive;
  const inspected = await inspectProjectBackup(archive);
  if (expectedMode === "rollback")
    result.actual_time = inspected.manifest.created_at;
  if (
    plan.action !== "rollback" &&
    (inspected.manifest.content_root !== operation.archive_digest ||
      JSON.stringify(inspected.checkpoint) !==
        JSON.stringify(operation.checkpoint))
  )
    throw new Error("Checkpoint changed after selection");
  const context: Omit<ProjectRecoveryContext, "safety_digest"> = {
    policy: "preserve-current-access",
    checkpoint: operation.checkpoint,
    requested_at: operation.requested_at,
    archive_digest: operation.archive_digest,
    safety_archive: operation.safety_backup,
  };
  const record = operationPath(operation.directory, operation.operation_id);
  await mkdir(join(operation.directory, ".safety"), {
    recursive: true,
    mode: 0o700,
  });
  if (existsSync(record)) {
    const existing = OperationSchema.parse(
      JSON.parse(await readFile(record, "utf8")),
    );
    if (JSON.stringify(existing) !== JSON.stringify(operation))
      throw new Error("Recovery operation cannot be changed");
  } else {
    if (plan.action !== "restore")
      throw new Error("Recovery operation record is missing");
    await writeFile(record, `${JSON.stringify(operation)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  }
  const status = await client.json<{
    state: { session_id: string; mode: string } | null;
  }>("/transfer/status");
  if (status.state && status.state.session_id !== operation.operation_id)
    throw new Error("Another project transfer is active");
  const resume = status.state?.mode === "import";
  const rollback =
    plan.action === "rollback" || status.state?.mode === "rollback";
  if (rollback && plan.action !== "rollback")
    throw new Error(
      "Operation is rolling back; use --rollback with its operation ID",
    );
  if (rollback && (!status.state || status.state.mode === "export"))
    throw new Error("No interrupted restore is available to roll back");
  await importProjectBackup({
    archive,
    destination: source,
    replace: true,
    resume,
    rollback,
    recovery: { operationId: operation.operation_id, context },
  });
  const verified = await client.json<{
    receipt: { mode: string; archive_digest: string } | null;
  }>(`/recovery/${operation.operation_id}`);
  if (
    verified.receipt?.mode !== expectedMode ||
    verified.receipt.archive_digest !== inspected.manifest.content_root
  )
    throw new Error(
      "Recovery completion could not be verified; resume the operation",
    );
  return result;
}
