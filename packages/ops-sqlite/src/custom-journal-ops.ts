import { type JournalArchiveReader, completeReplay } from "@tila/core";
import {
  CUSTOM_REPORT_PRINCIPAL_RATE,
  CUSTOM_REPORT_PROJECT_RATE,
  CUSTOM_REPORT_RETENTION_MS,
  type CredentialPolicy,
  type JournalAppendRequest,
  JournalAppendRequestSchema,
  type JournalAppendResponse,
  JournalAppendResponseSchema,
  JournalIdempotencyKeySchema,
  JournalReportedEventSchema,
  canonicalJson,
  hasNamespaceRestrictions,
} from "@tila/schemas";
import { and, eq, lt, lte } from "drizzle-orm";
import { highSequence, replaySnapshot } from "./continuity-ops";
import { CredentialPolicyDenied } from "./credential-policy";
import {
  ExpiredClaimError,
  assertResourceFence,
  resolveEntityResource,
} from "./fence-ops";
import type { RequestOrigin } from "./journal-ops";
import type { ProjectDatabase } from "./queue-internals";
import * as schema from "./schema";

export class JournalReportError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly retryAfter?: number,
  ) {
    super(message);
  }
}

function capability(
  policy: CredentialPolicy | undefined,
  name: CredentialPolicy["capabilities"][number],
) {
  if (policy && !policy.capabilities.includes(name))
    throw new CredentialPolicyDenied();
}

/** Only resources whose contents are already project-visible can be attached. */
function resourceReference(
  db: ProjectDatabase,
  resource: string,
  policy?: CredentialPolicy,
): string {
  if (resource.startsWith("record:")) {
    capability(policy, "records:read");
    const slash = resource.indexOf("/", 7);
    const row =
      slash > 7
        ? db
            .select()
            .from(schema.records)
            .where(
              and(
                eq(schema.records.type, resource.slice(7, slash)),
                eq(schema.records.key, resource.slice(slash + 1)),
              ),
            )
            .get()
        : undefined;
    if (row) return `record:${row.type}/${row.key}`;
  } else {
    capability(policy, "tasks:read");
    const canonical = resolveEntityResource(db, resource);
    if (canonical) return canonical;
  }
  throw new JournalReportError(
    "not-found",
    "Reference must identify an existing task or record in this project",
    404,
  );
}

function validateReferences(
  db: ProjectDatabase,
  input: JournalAppendRequest,
  projectId: string,
  policy: CredentialPolicy | undefined,
  now: number,
): string {
  const resource =
    input.target.kind === "project"
      ? `project:${projectId}`
      : resourceReference(db, input.target.resource, policy);
  for (const key of input.artifact_refs ?? []) {
    capability(policy, "artifacts:read");
    const artifact = db
      .select()
      .from(schema.artifactPointers)
      .where(eq(schema.artifactPointers.r2_key, key))
      .get();
    if (
      !artifact ||
      artifact.tombstoned ||
      (artifact.expires_at !== null && artifact.expires_at <= now)
    )
      throw new JournalReportError(
        "not-found",
        "Artifact reference is unavailable in this project",
        404,
      );
    if (artifact.resource && artifact.resource !== `project:${projectId}`)
      resourceReference(db, artifact.resource, policy);
  }
  return resource;
}

export function cleanupJournalReports(
  db: ProjectDatabase,
  now = Date.now(),
): void {
  db.delete(schema.journalReportReceipts)
    .where(lte(schema.journalReportReceipts.expires_at, now))
    .run();
  db.delete(schema.journalReportRates)
    .where(
      lt(
        schema.journalReportRates.window_start,
        Math.floor(now / 60_000) * 60_000,
      ),
    )
    .run();
}

export async function appendReport(
  db: ProjectDatabase,
  options: {
    projectId: string;
    origin: RequestOrigin;
    input: JournalAppendRequest;
    idempotencyKey: string;
    policy?: CredentialPolicy;
    archives?: JournalArchiveReader;
    /** Recheck the transfer lock after asynchronous archive/hash work. */
    assertWritable?: () => void;
    now?: number;
  },
): Promise<{ response: JournalAppendResponse; replayed: boolean }> {
  const input = JournalAppendRequestSchema.parse(options.input);
  const idempotencyKey = JournalIdempotencyKeySchema.parse(
    options.idempotencyKey,
  );
  const { origin, projectId, policy } = options;
  if (!origin.principalId || !origin.participantId)
    throw new JournalReportError(
      "participant-required",
      "Explicit canonical identity is required",
    );
  if (policy && (policy.role === "viewer" || hasNamespaceRestrictions(policy)))
    throw new CredentialPolicyDenied();
  capability(policy, "journal:append");
  // Validate access before any archived content is read, then again in the write transaction.
  validateReferences(db, input, projectId, policy, options.now ?? Date.now());
  let correction: JournalAppendRequest | undefined;
  if (input.corrects_seq !== undefined) {
    capability(policy, "journal:read");
    if (input.corrects_seq > highSequence(db))
      throw new JournalReportError(
        "validation-error",
        "Correction sequence must identify an earlier report",
      );
    const replay = await completeReplay(
      replaySnapshot(db, {
        after_seq: input.corrects_seq - 1,
        through_seq: input.corrects_seq,
        limit: 1,
      }),
      options.archives,
    );
    const previous = JournalReportedEventSchema.safeParse(replay.events[0]);
    if (!previous.success)
      throw new JournalReportError(
        "validation-error",
        "Corrections must reference an earlier custom report",
      );
    correction = previous.data.data;
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(input)),
  );
  const requestHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const key = canonicalJson([
    projectId,
    origin.principalId,
    origin.participantId,
    idempotencyKey,
  ]);
  return db.transaction((tx) => {
    options.assertWritable?.();
    const now = options.now ?? Date.now();
    const resource = validateReferences(tx, input, projectId, policy, now);
    if (correction) validateReferences(tx, correction, projectId, policy, now);
    if (input.target.kind === "claim") {
      capability(policy, "claims:read");
      assertResourceFence(tx, resource, input.target.fence);
      const claim = tx
        .select()
        .from(schema.claims)
        .where(eq(schema.claims.resource, resource))
        .get();
      if (
        !claim ||
        claim.expires_at <= now ||
        claim.fence !== input.target.fence
      )
        throw new ExpiredClaimError(resource);
      if (
        claim.principal_id !== origin.principalId ||
        claim.participant_id !== origin.participantId
      )
        throw new CredentialPolicyDenied();
    }
    cleanupJournalReports(tx, now);
    const receipt = tx
      .select()
      .from(schema.journalReportReceipts)
      .where(eq(schema.journalReportReceipts.key, key))
      .get();
    if (receipt) {
      if (receipt.request_hash !== requestHash)
        throw new JournalReportError(
          "idempotency-key-conflict",
          "Idempotency-Key reused with a different report",
          422,
        );
      return {
        response: JournalAppendResponseSchema.parse(
          JSON.parse(receipt.response),
        ),
        replayed: true,
      };
    }
    const windowStart = Math.floor(now / 60_000) * 60_000;
    for (const [rateKey, limit] of [
      ["project", CUSTOM_REPORT_PROJECT_RATE],
      [
        canonicalJson(["principal", origin.principalId]),
        CUSTOM_REPORT_PRINCIPAL_RATE,
      ],
    ] as const) {
      const counter = tx
        .select()
        .from(schema.journalReportRates)
        .where(eq(schema.journalReportRates.key, rateKey))
        .get();
      if ((counter?.count ?? 0) >= limit)
        throw new JournalReportError(
          "rate-limited",
          "Custom report append rate exceeded",
          429,
          Math.ceil((windowStart + 60_000 - now) / 1000),
        );
      tx.insert(schema.journalReportRates)
        .values({
          key: rateKey,
          window_start: windowStart,
          count: (counter?.count ?? 0) + 1,
        })
        .onConflictDoUpdate({
          target: schema.journalReportRates.key,
          set: { window_start: windowStart, count: (counter?.count ?? 0) + 1 },
        })
        .run();
    }
    const data: JournalAppendRequest = {
      ...input,
      target:
        input.target.kind === "project"
          ? input.target
          : { ...input.target, resource },
    };
    const row = tx
      .insert(schema.journal)
      .values({
        t: now,
        kind: "custom.reported",
        resource,
        principal_id: origin.principalId,
        participant_id: origin.participantId,
        environment: JSON.stringify(origin.environment),
        token_id: origin.tokenId ?? null,
        fence: input.target.kind === "claim" ? input.target.fence : null,
        actor: "",
        source: null,
        source_version: null,
        data: JSON.stringify(data),
      })
      .returning()
      .get();
    const response = JournalAppendResponseSchema.parse({
      ok: true,
      event: JournalReportedEventSchema.parse({
        ...row,
        environment: origin.environment,
        data,
      }),
      dedup_expires_at: now + CUSTOM_REPORT_RETENTION_MS,
    });
    tx.insert(schema.journalReportReceipts)
      .values({
        key,
        project_id: projectId,
        principal_id: origin.principalId,
        participant_id: origin.participantId,
        request_hash: requestHash,
        response: JSON.stringify(response),
        expires_at: response.dedup_expires_at,
      })
      .run();
    return { response, replayed: false };
  });
}

export function validateJournalReportBackupRow(
  table: string,
  row: Record<string, unknown>,
): void {
  if (table === "journal_report_rates") {
    const validKey =
      row.key === "project" ||
      (typeof row.key === "string" &&
        (() => {
          const key = JSON.parse(row.key);
          return (
            Array.isArray(key) &&
            key.length === 2 &&
            key[0] === "principal" &&
            typeof key[1] === "string" &&
            key[1].length > 0
          );
        })());
    const limit =
      row.key === "project"
        ? CUSTOM_REPORT_PROJECT_RATE
        : CUSTOM_REPORT_PRINCIPAL_RATE;
    if (
      !validKey ||
      !Number.isSafeInteger(row.window_start) ||
      Number(row.window_start) < 0 ||
      Number(row.window_start) % 60_000 !== 0 ||
      !Number.isInteger(row.count) ||
      Number(row.count) < 0 ||
      Number(row.count) > limit
    )
      throw new JournalReportError(
        "validation-error",
        "Invalid custom journal rate counter in backup",
      );
  }
  if (table === "journal" && row.kind === "custom.reported") {
    JournalReportedEventSchema.parse({
      ...row,
      data: JSON.parse(String(row.data)),
      environment: JSON.parse(String(row.environment)),
    });
  }
  if (table !== "journal_report_receipts") return;
  const receipt = JournalAppendResponseSchema.parse(
    JSON.parse(String(row.response)),
  );
  const key = JSON.parse(String(row.key));
  if (
    !Array.isArray(key) ||
    key.length !== 4 ||
    key[0] !== row.project_id ||
    key[1] !== row.principal_id ||
    key[2] !== row.participant_id ||
    !JournalIdempotencyKeySchema.safeParse(key[3]).success ||
    !/^[a-f0-9]{64}$/.test(String(row.request_hash)) ||
    receipt.event.principal_id !== row.principal_id ||
    receipt.event.participant_id !== row.participant_id ||
    receipt.dedup_expires_at !== row.expires_at ||
    receipt.event.t + CUSTOM_REPORT_RETENTION_MS !== row.expires_at
  )
    throw new JournalReportError(
      "validation-error",
      "Invalid custom journal receipt in backup",
    );
}
