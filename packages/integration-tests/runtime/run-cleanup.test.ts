import { SELF, runDurableObjectAlarm } from "cloudflare:test";
import type { CredentialPolicy } from "@tila/schemas";
import {
  TilaApiError,
  TilaClient,
  createArtifactMethods,
  createClaimMethods,
  createRecordMethods,
} from "tila-sdk";
import { describe, expect, it } from "vitest";
import { policyFromArgs } from "../../cli/src/lib/credential-policy";
import { hashToken } from "../../worker/src/lib/hash-token";
import { bindings } from "./setup";

/**
 * Cleanup of run-created resources without widening the `worker` preset (#362).
 *
 * The worker preset carries no `records:delete`/`artifacts:delete`, so a run
 * cannot remove what it wrote. These cases reproduce that refusal and exercise
 * the documented alternative in docs/05-OPERATIONS.md: a separate cleanup
 * identity that acts only on resources named by an owner-reviewed run receipt,
 * with current fences and stable retry keys. All identities are synthetic.
 *
 * Tila has no server-side receipt and no creator-based delete. `cleanFromReceipt`
 * below is the documented operator procedure expressed as test code, not a
 * shipped tool. It exists to prove the procedure is executable end to end,
 * that artifact state is verified while holding the lineage claim, and that
 * every refusal happens before a destructive request is sent. Cleanup is NOT
 * atomic across resources: records and artifacts are separate operations in
 * separate stores, and a failure after some succeeded leaves those removed.
 */

const definition = `schema_version = 1
[records.rehearsal]
format = "json"
history = "revision"
[records.rehearsal.fields]
note = { type = "string", required = true }
[records.other]
format = "json"
history = "revision"
[records.other.fields]
note = { type = "string", required = true }
[artifacts.report]
`;

const RUN = "run-0001";
const OTHER_RUN = "run-0002";

async function project() {
  const projectId = `cleanup-${crypto.randomUUID()}`;
  const owner = `owner-${crypto.randomUUID()}`;
  await bindings.DB.prepare(
    "INSERT INTO _projects (project_id, display_name, created_at, created_by, cloudflare_account_id) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(projectId, projectId, Date.now(), "fixture", "local")
    .run();
  await bindings.DB.prepare(
    "INSERT INTO _tokens (token_hash, project_id, name, scopes, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      await hashToken(owner, bindings.HASH_PEPPER),
      projectId,
      "init",
      "full",
      Date.now(),
      "fixture",
    )
    .run();
  const ownerCall = async <T>(
    path: string,
    body?: unknown,
    method?: string,
  ) => {
    const response = await SELF.fetch(`https://worker${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        Authorization: `Bearer ${owner}`,
        "X-Tila-Participant-Id": "owner-fixture",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = (await response.json()) as T;
    return { status: response.status, body: parsed };
  };
  const schema = await ownerCall(`/projects/${projectId}/schema`, {
    definition,
    expected_revision: 0,
  });
  expect(schema.status, JSON.stringify(schema.body)).toBe(200);
  return { projectId, owner, ownerCall };
}

type Fixture = Awaited<ReturnType<typeof project>>;

/** Owner side: a service identity with explicit membership plus one key. */
async function identity(
  f: Fixture,
  name: string,
  membership: "viewer" | "participant",
  policy: CredentialPolicy,
) {
  const service = await f.ownerCall<{
    service_account: { principal_id: string };
  }>(`/projects/${f.projectId}/service-accounts`, {
    name,
    display_name: name,
    role: membership,
  });
  expect(service.status, JSON.stringify(service.body)).toBe(201);
  const issued = await f.ownerCall<{ token: string }>("/api/tokens", {
    name: `${name}-key`,
    principal_id: service.body.service_account.principal_id,
    policy,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
  expect(issued.status, JSON.stringify(issued.body)).toBe(201);
  return {
    token: issued.body.token,
    principalId: service.body.service_account.principal_id,
  };
}

interface Seen {
  method: string;
  path: string;
}
const isDestructive = ({ method, path }: Seen) =>
  method === "DELETE" ||
  /\/artifacts\/~\/destroy\//.test(path) ||
  /\/records\/.+\/~\/archive\//.test(path);

function client(f: Fixture, token: string, participantId: string) {
  const seen: Seen[] = [];
  const tila = new TilaClient({
    baseUrl: "https://worker",
    token,
    participantId,
    fetch: async (input, init) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL
          ? input
          : (input as Request).url,
      );
      seen.push({ method: init?.method ?? "GET", path: url.pathname });
      // workerd does not implement the SDK's `redirect: "error"` mode.
      return SELF.fetch(input, { ...init, redirect: "manual" });
    },
  });
  return {
    tila,
    records: createRecordMethods(tila, f.projectId),
    claims: createClaimMethods(tila, f.projectId),
    artifacts: createArtifactMethods(tila, f.projectId),
    /** Every non-GET request, including claim acquisition and release. */
    mutations: () => seen.filter((r) => r.method !== "GET"),
    /** Only archive, delete and destroy requests. */
    destructive: () => seen.filter(isDestructive),
  };
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TilaApiError) return error;
    throw error;
  }
  throw new Error("Expected the request to be refused");
}

const WORKER_POLICY = policyFromArgs({ preset: "worker" });
// `tila token issue --role participant --capabilities ... --restrictions ...`
const RECORD_CLEANER_ARGS = (prefix: string) => ({
  preset: "read-only",
  role: "participant",
  capabilities: "records:read,records:delete",
  restrictions: JSON.stringify({
    records: [{ type: "rehearsal", key_prefixes: [prefix] }],
  }),
});
const ARTIFACT_CLEANER_ARGS = {
  preset: "read-only",
  role: "participant",
  capabilities:
    "artifacts:read,artifacts:delete,claims:read,claims:acquire,claims:release",
};

interface ReceiptRevision {
  r2_key: string;
  revision: number;
  sha256: string;
}
interface ReceiptArtifact {
  lineage_id: string;
  revisions: ReceiptRevision[];
  /** Only when the receipt asserts the lineage is exclusive to this run. */
  destroy_lineage: boolean;
}
/**
 * What the run reports and the owner reviews. Tila neither stores nor validates
 * it: the owner's review is a human step, so `reviewed_by` is recorded for the
 * audit trail and is NOT something the procedure can verify. The cleanup
 * principal IS verifiable, against `GET /api/whoami`.
 */
interface RunReceipt {
  project_id: string;
  instance_id: string;
  run_id: string;
  reviewed_by: string;
  cleanup_principal_ids: string[];
  /**
   * `archive-only`: records are archived and no artifact bytes may be removed.
   * `delete-bytes`: the owner also authorised removing the listed artifacts.
   */
  retention: "archive-only" | "delete-bytes";
  records: { type: string; key: string }[];
  artifacts: ReceiptArtifact[];
}

class Refused extends Error {
  constructor(
    readonly reason: string,
    /** Non-GET requests sent before refusing. */
    readonly mutations: Seen[],
    /** Archive, delete or destroy requests sent before refusing. */
    readonly destructive: Seen[],
  ) {
    super(reason);
  }
}

// Functional core: pure verification rules, no I/O.
interface WhoAmI {
  project_id: string;
  instance_id?: string;
  principal_id?: string;
}
function identityRefusal(receipt: RunReceipt, me: WhoAmI): string | null {
  if (me.project_id !== receipt.project_id) return "project";
  if (me.instance_id !== receipt.instance_id) return "deployment";
  if (!me.principal_id) return "principal";
  if (!receipt.cleanup_principal_ids.includes(me.principal_id))
    return "principal";
  return null;
}
/**
 * The receipt must be internally consistent before it is compared with
 * anything: a repeated lineage or revision key could otherwise make counts
 * agree while an unlisted key stays live.
 */
function receiptRefusal(receipt: RunReceipt): string | null {
  const records = new Set<string>();
  for (const { type, key } of receipt.records) {
    const id = `${type}/${key}`;
    if (records.has(id)) return `duplicate-record:${id}`;
    records.add(id);
  }
  const lineages = new Set<string>();
  const keys = new Set<string>();
  for (const item of receipt.artifacts) {
    if (lineages.has(item.lineage_id))
      return `duplicate-lineage:${item.lineage_id}`;
    lineages.add(item.lineage_id);
    if (item.revisions.length === 0) return `empty-lineage:${item.lineage_id}`;
    const numbers = new Set<number>();
    for (const rev of item.revisions) {
      if (keys.has(rev.r2_key)) return `duplicate-revision:${rev.r2_key}`;
      keys.add(rev.r2_key);
      if (numbers.has(rev.revision))
        return `duplicate-revision-number:${item.lineage_id}/${rev.revision}`;
      numbers.add(rev.revision);
    }
  }
  return null;
}
interface LivePointer {
  r2_key: string;
  lineage_id: string | null;
  revision: number;
  sha256: string;
  tombstoned?: unknown;
  blob_deleted_at?: number | null;
}
const available = (p: LivePointer) =>
  !p.tombstoned && p.blob_deleted_at == null;
function lineageRefusal(
  item: ReceiptArtifact,
  live: LivePointer[],
): string | null {
  const byKey = new Map(live.map((p) => [p.r2_key, p]));
  const receiptKeys = new Set(item.revisions.map((r) => r.r2_key));
  for (const rev of item.revisions) {
    const p = byKey.get(rev.r2_key);
    if (
      !p ||
      p.lineage_id !== item.lineage_id ||
      p.revision !== rev.revision ||
      p.sha256 !== rev.sha256
    )
      return `mismatch:${rev.r2_key}`;
  }
  // Retiring a lineage removes every revision, so no available revision may
  // sit outside the receipt. Compare the actual key sets, never counts.
  // Per-revision deletion touches only the listed keys.
  if (
    item.destroy_lineage &&
    live.some((p) => !receiptKeys.has(p.r2_key) && available(p))
  )
    return `lineage-not-exclusive:${item.lineage_id}`;
  return null;
}

interface Hooks {
  /** Runs after identity and scope checks, before any claim is requested. */
  beforeClaims?: () => Promise<void>;
  /** Runs once every lineage claim is held, before the history re-read. */
  afterClaims?: () => Promise<void>;
}

/**
 * The documented procedure (imperative shell). `phase` selects which reviewed
 * credential is in use: record cleaning and artifact cleaning use separate keys.
 *
 * Artifact state is verified only after every lineage claim is held. A claim is
 * exclusive, so no writer can append between that verification and the
 * destructive call; a read taken before the claim would prove nothing.
 */
async function cleanFromReceipt(
  f: Fixture,
  receipt: RunReceipt,
  phase: "records" | "artifacts",
  token: string,
  options: {
    requested?: { records?: string[]; lineages?: string[] };
    hooks?: Hooks;
  } = {},
) {
  const c = client(f, token, `cleanup-${receipt.run_id}-${phase}`);
  const refuse = (reason: string) =>
    new Refused(reason, c.mutations(), c.destructive());

  // 0. The receipt itself is consistent. Nothing has been requested yet.
  const structural = receiptRefusal(receipt);
  if (structural) throw refuse(structural);

  // 1. The deployment, project and credential are the reviewed ones.
  const me = await c.tila.get<WhoAmI>("/api/whoami");
  const identityIssue = identityRefusal(receipt, me);
  if (identityIssue) throw refuse(identityIssue);

  // 2. Scope: anything not in the receipt is refused, never inferred.
  const knownRecords = new Set(
    receipt.records.map((r) => `${r.type}/${r.key}`),
  );
  for (const key of options.requested?.records ?? [])
    if (!knownRecords.has(key)) throw refuse(`not-in-receipt:${key}`);
  const knownLineages = new Set(receipt.artifacts.map((a) => a.lineage_id));
  for (const lineage of options.requested?.lineages ?? [])
    if (!knownLineages.has(lineage)) throw refuse(`not-in-receipt:${lineage}`);

  const done: string[] = [];
  const releaseFailures: string[] = [];

  if (phase === "records") {
    // 3a. Read each record. The record fence is a compare-and-set, so a record
    // changed after this read is refused at the archive call.
    const plan: { type: string; key: string; fence: number }[] = [];
    for (const { type, key } of receipt.records) {
      let live: Awaited<ReturnType<typeof c.records.get>>;
      try {
        live = await c.records.get(type, key);
      } catch {
        throw refuse(`uncertain:${type}/${key}`);
      }
      if (live.record.archived) continue;
      plan.push({ type, key, fence: live.fence });
    }
    for (const { type, key, fence } of plan) {
      await c.records.archive(type, key, { fence });
      done.push(`record:${type}/${key}`);
    }
    return { done, releaseFailures, c };
  }

  // 3b. Artifact bytes are removable only when the owner said so.
  if (receipt.retention !== "delete-bytes") throw refuse("retention");

  const held: { resource: string; fence: number; lineage: string }[] = [];
  try {
    await options.hooks?.beforeClaims?.();
    // 4. Take every lineage claim, in a fixed order, before reading anything
    // that will justify a destructive call.
    const ordered = [...receipt.artifacts].sort((a, b) =>
      a.lineage_id.localeCompare(b.lineage_id),
    );
    for (const item of ordered) {
      const resource = `artifact:${item.lineage_id}`;
      let claim: Awaited<ReturnType<typeof c.claims.acquire>>;
      try {
        claim = await c.claims.acquire(resource, "exclusive", 60_000);
      } catch {
        throw refuse(`claim-unavailable:${item.lineage_id}`);
      }
      held.push({ resource, fence: claim.fence, lineage: item.lineage_id });
    }
    await options.hooks?.afterClaims?.();

    // 5. Re-read exact state under the claims and verify all of it first.
    const plan: {
      lineage: string;
      fence: number;
      keys: string[];
      destroy: boolean;
    }[] = [];
    for (const item of ordered) {
      let live: LivePointer[];
      try {
        live = [];
        let cursor: string | undefined;
        do {
          const page = await c.artifacts.history(item.revisions[0].r2_key, {
            limit: 100,
            cursor,
          });
          live.push(...(page.items as LivePointer[]));
          cursor = page.meta.next_cursor ?? undefined;
        } while (cursor);
      } catch {
        throw refuse(`uncertain:${item.lineage_id}`);
      }
      const issue = lineageRefusal(item, live);
      if (issue) throw refuse(issue);
      const byKey = new Map(live.map((p) => [p.r2_key, p]));
      plan.push({
        lineage: item.lineage_id,
        fence: held.find((h) => h.lineage === item.lineage_id)?.fence ?? 0,
        keys: item.revisions
          .map((r) => r.r2_key)
          .filter((k) => !byKey.get(k)?.tombstoned),
        destroy: item.destroy_lineage,
      });
    }

    // 6. Only now: destructive calls, fenced and with stable per-item keys.
    for (const p of plan) {
      if (p.keys.length === 0) continue;
      if (p.destroy)
        await c.artifacts.destroyLineage(p.lineage, {
          fence: p.fence,
          idempotencyKey: `cleanup:${receipt.run_id}:destroy:${p.lineage}`,
        });
      else
        for (const key of p.keys)
          await c.artifacts.delete(key, {
            fence: p.fence,
            idempotencyKey: `cleanup:${receipt.run_id}:delete:${key}`,
          });
      done.push(`artifact:${p.lineage}`);
    }
  } finally {
    for (const h of held.reverse()) {
      try {
        await c.claims.release(h.resource, h.fence);
      } catch {
        // Never mask the primary outcome; the claim expires with its TTL.
        releaseFailures.push(h.resource);
      }
    }
  }
  return { done, releaseFailures, c };
}

async function writeRevision(
  f: Fixture,
  w: ReturnType<typeof client>,
  lineage: string,
  fence: number,
  content: string,
): Promise<ReceiptRevision> {
  const written = await w.tila.post<{
    key: string;
    pointer: { revision: number; sha256: string };
  }>(`/projects/${f.projectId}/artifacts/text`, {
    content,
    kind: "report",
    mime_type: "text/plain",
    lineage_id: lineage,
    lineage_fence: fence,
  });
  return {
    r2_key: written.key,
    revision: written.pointer.revision,
    sha256: written.pointer.sha256,
  };
}

/** Worker side: records plus `revisions` artifact revisions under run names. */
async function runWrites(
  f: Fixture,
  token: string,
  run: string,
  revisions = 1,
) {
  const w = client(f, token, `worker-${run}`);
  const lineage = `${run}-report`;
  const created = await w.records.create("rehearsal", {
    key: `${run}/main`,
    value: { note: "created" },
  });
  const patched = await w.records.patch("rehearsal", `${run}/main`, {
    patch: { note: "patched" },
    fence: created.fence,
  });
  const claim = await w.claims.acquire(
    `artifact:${lineage}`,
    "exclusive",
    120_000,
  );
  const artifacts: ReceiptRevision[] = [];
  for (let i = 0; i < revisions; i++)
    artifacts.push(
      await writeRevision(
        f,
        w,
        lineage,
        claim.fence,
        `rehearsal output ${i} for ${run}`,
      ),
    );
  return {
    w,
    lineage,
    recordFence: patched.fence,
    claim,
    artifacts,
    artifact: artifacts[0],
    release: () => w.claims.release(`artifact:${lineage}`, claim.fence),
    /** A concurrent writer appends a revision and lets go, as a run would. */
    append: async (content: string) => {
      const resource = `artifact:${lineage}`;
      const next = await w.claims.acquire(resource, "exclusive", 60_000);
      const revision = await writeRevision(f, w, lineage, next.fence, content);
      await w.claims.release(resource, next.fence);
      return revision;
    },
  };
}

async function instanceId(f: Fixture) {
  const who = await f.ownerCall<{ instance_id: string }>("/api/whoami");
  expect(who.status).toBe(200);
  expect(who.body.instance_id).toBeTruthy();
  return who.body.instance_id;
}

async function drain(f: Fixture) {
  const stub = bindings.PROJECT.get(bindings.PROJECT.idFromName(f.projectId));
  await runDurableObjectAlarm(stub);
}

describe("run cleanup without widening the worker preset (#362)", () => {
  it("refuses worker-preset archive, delete and destroy and changes nothing", async () => {
    const f = await project();
    const worker = await identity(f, "rehearsal", "participant", WORKER_POLICY);
    expect(WORKER_POLICY.capabilities).not.toContain("records:delete");
    expect(WORKER_POLICY.capabilities).not.toContain("artifacts:delete");

    const run = await runWrites(f, worker.token, RUN);
    const denied = [
      await failure(
        run.w.records.archive("rehearsal", `${RUN}/main`, {
          fence: run.recordFence,
        }),
      ),
      await failure(
        run.w.artifacts.delete(run.artifact.r2_key, {
          fence: run.claim.fence,
          idempotencyKey: "worker-delete",
        }),
      ),
      await failure(
        run.w.artifacts.destroyLineage(run.lineage, {
          fence: run.claim.fence,
          idempotencyKey: "worker-destroy",
        }),
      ),
    ];
    for (const error of denied) {
      expect(error.status).toBe(403);
      expect(error.code).toBe("permission-denied");
    }

    // Nothing was archived, tombstoned or removed.
    const record = await run.w.records.get("rehearsal", `${RUN}/main`);
    expect(record.record.archived).toBe(0);
    expect(record.fence).toBe(run.recordFence);
    const meta = await run.w.artifacts.meta(run.artifact.r2_key);
    expect(meta.pointer.tombstoned).toBeFalsy();
    expect(await bindings.ARTIFACTS.get(run.artifact.r2_key)).not.toBeNull();
  });

  it("archives only records within the cleaner's prefix, with the current fence", async () => {
    const f = await project();
    const worker = await identity(f, "rehearsal", "participant", WORKER_POLICY);
    const cleaner = await identity(
      f,
      "record-cleaner",
      "participant",
      policyFromArgs(RECORD_CLEANER_ARGS(RUN)),
    );
    const mine = await runWrites(f, worker.token, RUN);
    const theirs = await runWrites(f, worker.token, OTHER_RUN);
    const c = client(f, cleaner.token, "cleaner");

    // A stale fence is refused, and the record stays active.
    const stale = await failure(
      c.records.archive("rehearsal", `${RUN}/main`, {
        fence: mine.recordFence - 1,
      }),
    );
    expect(stale.status).toBe(409);
    expect(stale.code).toBe("stale-fence");
    expect(
      (await c.records.get("rehearsal", `${RUN}/main`)).record.archived,
    ).toBe(0);

    // Outside the granted prefix or type: refused by the server, state intact.
    const sibling = await failure(
      c.records.archive("rehearsal", `${OTHER_RUN}/main`, {
        fence: theirs.recordFence,
      }),
    );
    expect(sibling.status).toBe(403);
    const readOutside = await failure(
      c.records.get("rehearsal", `${OTHER_RUN}/main`),
    );
    expect(readOutside.status).toBe(403);
    const otherType = await failure(
      c.records.archive("other", `${RUN}/main`, { fence: 1 }),
    );
    expect(otherType.status).toBe(403);

    // The current fence archives; the record is archived, not byte-deleted.
    const live = await c.records.get("rehearsal", `${RUN}/main`);
    const archived = await c.records.archive("rehearsal", `${RUN}/main`, {
      fence: live.fence,
    });
    expect(archived.record.archived).toBe(1);
    expect(archived.fence).toBe(live.fence + 1);
    const history = await c.records.history("rehearsal", `${RUN}/main`, {
      values: true,
    });
    expect(history.items.length).toBeGreaterThanOrEqual(3);

    // Replaying the original fence after a lost response is refused rather than
    // applied twice; the operator confirms by reading the record.
    const retry = await failure(
      c.records.archive("rehearsal", `${RUN}/main`, { fence: live.fence }),
    );
    expect(retry.status).toBeGreaterThanOrEqual(400);
    expect(
      (await c.records.get("rehearsal", `${RUN}/main`)).record.archived,
    ).toBe(1);
    expect(
      (
        await f.ownerCall<{ record: { archived: number } }>(
          `/projects/${f.projectId}/records/rehearsal/${OTHER_RUN}/main`,
        )
      ).body.record.archived,
    ).toBe(0);
  });

  it("silently loses delete authority when either the membership or the key role is only viewer", async () => {
    const f = await project();
    const worker = await identity(f, "rehearsal", "participant", WORKER_POLICY);
    const run = await runWrites(f, worker.token, RUN);
    const { role: _role, ...withoutRole } = RECORD_CLEANER_ARGS(RUN);
    const cases = [
      // The flags are right, but `tila service-account create` defaulted to
      // `--role viewer`.
      ["viewer-membership", "viewer", policyFromArgs(RECORD_CLEANER_ARGS(RUN))],
      // The membership is right, but `--role` was omitted on `tila token issue`:
      // `--capabilities` replaces the preset's list, not its viewer role.
      ["viewer-key", "participant", policyFromArgs(withoutRole)],
    ] as const;
    for (const [name, membership, policy] of cases) {
      const cleaner = await identity(f, name, membership, policy);
      const c = client(f, cleaner.token, name);
      // Issuance succeeds, which is why this is easy to miss.
      const refused = await failure(
        c.records.archive("rehearsal", `${RUN}/main`, {
          fence: run.recordFence,
        }),
      );
      expect(refused.status, name).toBe(403);
      const who = await c.tila.get<{
        role?: string;
        policy?: CredentialPolicy;
      }>("/api/whoami");
      expect(who.role, name).toBe("viewer");
      expect(who.policy?.capabilities, name).not.toContain("records:delete");
    }
    expect(
      (await run.w.records.get("rehearsal", `${RUN}/main`)).record.archived,
    ).toBe(0);
  });

  it("deletes artifact revisions only with a live claim fence, and drains bytes asynchronously", async () => {
    const f = await project();
    const worker = await identity(f, "rehearsal", "participant", WORKER_POLICY);
    const cleaner = await identity(
      f,
      "artifact-cleaner",
      "participant",
      policyFromArgs(ARTIFACT_CLEANER_ARGS),
    );
    const mine = await runWrites(f, worker.token, RUN);
    const other = await runWrites(f, worker.token, OTHER_RUN);
    const c = client(f, cleaner.token, "cleaner");
    const resource = `artifact:${mine.lineage}`;
    const key = mine.artifact.r2_key;

    // While the run still holds the lineage claim the cleaner cannot take it.
    const held = await failure(c.claims.acquire(resource, "exclusive", 60_000));
    expect(held.status).toBe(409);
    await mine.release();

    const claim = await c.claims.acquire(resource, "exclusive", 60_000);
    expect(claim.fence).toBeGreaterThan(mine.claim.fence);

    // The run's old fence is stale and the key is unchanged.
    const stale = await failure(
      c.artifacts.delete(key, {
        fence: mine.claim.fence,
        idempotencyKey: "stale-attempt",
      }),
    );
    expect(stale.status).toBe(409);
    expect(stale.code).toBe("stale-fence");
    expect(await bindings.ARTIFACTS.get(key)).not.toBeNull();

    // No fence at all is refused.
    const unfenced = await failure(
      c.artifacts.delete(key, { idempotencyKey: "no-fence" }),
    );
    expect(unfenced.status).toBe(400);
    expect(unfenced.message).toMatch(/fence/i);

    // The current fence is accepted: a durable tombstone, not byte removal.
    const stableKey = `cleanup:${RUN}:delete:${key}`;
    await c.artifacts.delete(key, {
      fence: claim.fence,
      idempotencyKey: stableKey,
    });
    expect((await c.artifacts.meta(key)).pointer.tombstoned).toBeTruthy();
    expect(await bindings.ARTIFACTS.get(key)).not.toBeNull();
    expect(
      (await c.artifacts.history(key)).items[0].blob_deleted_at,
    ).toBeNull();
    const unavailable = await failure(c.artifacts.download(key));
    expect(unavailable.status).toBe(410);

    // The same key retried after the claim is released is a replay, not a
    // second operation, even though no live claim remains.
    await c.claims.release(resource, claim.fence);
    await c.artifacts.delete(key, {
      fence: claim.fence,
      idempotencyKey: stableKey,
    });

    // Bytes leave R2 only when the lifecycle queue drains.
    await drain(f);
    expect(await bindings.ARTIFACTS.get(key)).toBeNull();
    expect(
      (await c.artifacts.history(key)).items[0].blob_deleted_at,
    ).toBeTypeOf("number");

    // A different run's lineage is untouched.
    expect(await bindings.ARTIFACTS.get(other.artifact.r2_key)).not.toBeNull();
  });

  it("states the limit: an artifact-capable cleaner is not bound to a run or prefix", async () => {
    const f = await project();
    const worker = await identity(f, "rehearsal", "participant", WORKER_POLICY);
    const restricted = await identity(
      f,
      "restricted-artifacts",
      "participant",
      {
        role: "participant",
        capabilities: ["artifacts:read", "artifacts:delete", "claims:acquire"],
        restrictions: {
          records: [{ type: "rehearsal", key_prefixes: [RUN] }],
        },
      },
    );
    const cleaner = await identity(
      f,
      "artifact-cleaner",
      "participant",
      policyFromArgs(ARTIFACT_CLEANER_ARGS),
    );
    const other = await runWrites(f, worker.token, OTHER_RUN);
    await other.release();

    // Artifact routes refuse every namespace-restricted credential, so there is
    // no prefix-scoped artifact cleaner to issue.
    const r = client(f, restricted.token, "restricted");
    const refused = await failure(r.artifacts.meta(other.artifact.r2_key));
    expect(refused.status).toBe(403);

    // The unrestricted cleaner has no notion of "this run's" artifacts: with
    // the lineage claim it removes anyone's. Only the receipt check prevents it.
    const c = client(f, cleaner.token, "cleaner");
    const claim = await c.claims.acquire(
      `artifact:${other.lineage}`,
      "exclusive",
      60_000,
    );
    await c.artifacts.delete(other.artifact.r2_key, {
      fence: claim.fence,
      idempotencyKey: "not-mine",
    });
    expect(
      (await c.artifacts.meta(other.artifact.r2_key)).pointer.tombstoned,
    ).toBeTruthy();
  });

  it("states the limit: a live lineage fence authorises any holder of artifacts:delete", async () => {
    const f = await project();
    const worker = await identity(f, "rehearsal", "participant", WORKER_POLICY);
    // No claims:acquire at all: it can only read the claim state.
    const reader = await identity(f, "fence-reader", "participant", {
      role: "participant",
      capabilities: ["artifacts:read", "artifacts:delete", "claims:read"],
    });
    const run = await runWrites(f, worker.token, RUN);
    const c = client(f, reader.token, "reader");
    const state = await c.tila.get<{ claim: { fence: number } }>(
      `/projects/${f.projectId}/claims/state/${encodeURIComponent(`artifact:${run.lineage}`)}`,
    );
    expect(state.claim.fence).toBe(run.claim.fence);
    // The fence and a live claim are checked; who holds the claim is not.
    await c.artifacts.delete(run.artifact.r2_key, {
      fence: state.claim.fence,
      idempotencyKey: "borrowed-fence",
    });
    expect(
      (await c.artifacts.meta(run.artifact.r2_key)).pointer.tombstoned,
    ).toBeTruthy();
  });

  it("states the limit: identical legacy bytes share one key that deletes without a fence", async () => {
    const f = await project();
    const worker = await identity(f, "rehearsal", "participant", WORKER_POLICY);
    const cleaner = await identity(
      f,
      "artifact-cleaner",
      "participant",
      policyFromArgs(ARTIFACT_CLEANER_ARGS),
    );
    // Uploads without lineage_id are content-addressed, not run-owned.
    const write = (participant: string) =>
      client(f, worker.token, participant).tila.post<{
        key: string;
        deduplicated?: boolean;
      }>(`/projects/${f.projectId}/artifacts/text`, {
        content: "identical output",
        kind: "report",
        mime_type: "text/plain",
      });
    const first = await write("run-a");
    const second = await write("run-b");
    expect(second.key).toBe(first.key);
    expect(first.key).toMatch(/^sources\//);
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);

    // One run's receipt names the key; removing it removes both runs' bytes,
    // with no fence and no claim.
    const c = client(f, cleaner.token, "cleaner");
    await c.artifacts.delete(first.key);
    expect(await bindings.ARTIFACTS.get(first.key)).toBeNull();
  });

  describe("receipt-driven procedure", () => {
    async function prepared(revisions = 2) {
      const f = await project();
      const worker = await identity(
        f,
        "rehearsal",
        "participant",
        WORKER_POLICY,
      );
      const mine = await runWrites(f, worker.token, RUN, revisions);
      const other = await runWrites(f, worker.token, OTHER_RUN);
      await mine.release();
      await other.release();
      const recordCleaner = await identity(
        f,
        "record-cleaner",
        "participant",
        policyFromArgs(RECORD_CLEANER_ARGS(RUN)),
      );
      const artifactCleaner = await identity(
        f,
        "artifact-cleaner",
        "participant",
        policyFromArgs(ARTIFACT_CLEANER_ARGS),
      );
      const receipt: RunReceipt = {
        project_id: f.projectId,
        instance_id: await instanceId(f),
        run_id: RUN,
        reviewed_by: "synthetic-owner",
        cleanup_principal_ids: [
          recordCleaner.principalId,
          artifactCleaner.principalId,
        ],
        retention: "delete-bytes",
        records: [{ type: "rehearsal", key: `${RUN}/main` }],
        artifacts: [
          {
            lineage_id: mine.lineage,
            revisions: mine.artifacts,
            destroy_lineage: true,
          },
        ],
      };
      return {
        f,
        worker,
        mine,
        other,
        receipt,
        recordCleaner,
        artifactCleaner,
      };
    }

    async function untouched(
      f: Fixture,
      keys: string[],
      archivedRecords: string[] = [],
    ) {
      for (const key of keys)
        expect(await bindings.ARTIFACTS.get(key), key).not.toBeNull();
      for (const run of [RUN, OTHER_RUN]) {
        const record = await f.ownerCall<{ record: { archived: number } }>(
          `/projects/${f.projectId}/records/rehearsal/${run}/main`,
        );
        expect(record.body.record.archived, run).toBe(
          archivedRecords.includes(run) ? 1 : 0,
        );
      }
    }

    it("removes exactly the receipt's resources, retires its lineage, retries idempotently and verifies", async () => {
      const {
        f,
        worker,
        mine,
        other,
        receipt,
        recordCleaner,
        artifactCleaner,
      } = await prepared();
      const records = await cleanFromReceipt(
        f,
        receipt,
        "records",
        recordCleaner.token,
      );
      expect(records.done).toEqual([`record:rehearsal/${RUN}/main`]);
      const artifacts = await cleanFromReceipt(
        f,
        receipt,
        "artifacts",
        artifactCleaner.token,
      );
      expect(artifacts.done).toEqual([`artifact:${mine.lineage}`]);
      expect(artifacts.releaseFailures).toEqual([]);
      // Exactly one destroy, no per-revision deletes.
      expect(artifacts.c.destructive()).toHaveLength(1);

      // Running the same procedure again sends nothing destructive.
      const again = await cleanFromReceipt(
        f,
        receipt,
        "artifacts",
        artifactCleaner.token,
      );
      expect(again.c.destructive()).toEqual([]);
      const recordsAgain = await cleanFromReceipt(
        f,
        receipt,
        "records",
        recordCleaner.token,
      );
      expect(recordsAgain.c.destructive()).toEqual([]);

      // Accepted retirement answers 410 at once, but that proves only that the
      // content is unavailable. The bytes are removed when the queue drains, and
      // `blob_deleted_at` is the evidence of that.
      const verify = again.c;
      const deletedAt = async (key: string) => {
        const { items } = await verify.artifacts.history(key);
        const pointer = (items as LivePointer[]).find((p) => p.r2_key === key);
        return pointer?.blob_deleted_at ?? null;
      };
      for (const rev of mine.artifacts) {
        const unavailable = await failure(
          verify.artifacts.download(rev.r2_key),
        );
        expect(unavailable.status).toBe(410);
        expect(await bindings.ARTIFACTS.get(rev.r2_key)).not.toBeNull();
        expect(await deletedAt(rev.r2_key)).toBeNull();
      }
      await drain(f);
      for (const rev of mine.artifacts) {
        expect(await bindings.ARTIFACTS.get(rev.r2_key)).toBeNull();
        expect(await deletedAt(rev.r2_key)).toBeTypeOf("number");
      }

      // The lineage is retired: the run's own writer can no longer append.
      const w = client(f, worker.token, "late-writer");
      const lateClaim = await w.claims.acquire(
        `artifact:${mine.lineage}`,
        "exclusive",
        60_000,
      );
      const late = await failure(
        writeRevision(f, w, mine.lineage, lateClaim.fence, "late"),
      );
      expect(late.status).toBe(410);

      // Everything else is exactly as the run left it.
      await untouched(f, [other.artifact.r2_key], [RUN]);
    });

    it("keeps artifacts when the receipt is archive-only", async () => {
      const { f, mine, other, receipt, recordCleaner, artifactCleaner } =
        await prepared();
      const archiveOnly: RunReceipt = { ...receipt, retention: "archive-only" };
      const records = await cleanFromReceipt(
        f,
        archiveOnly,
        "records",
        recordCleaner.token,
      );
      expect(records.done).toEqual([`record:rehearsal/${RUN}/main`]);
      const refused = await cleanFromReceipt(
        f,
        archiveOnly,
        "artifacts",
        artifactCleaner.token,
      ).then(
        () => null,
        (e: unknown) => e,
      );
      expect(refused).toBeInstanceOf(Refused);
      expect((refused as Refused).reason).toBe("retention");
      expect((refused as Refused).mutations).toEqual([]);
      await drain(f);
      await untouched(
        f,
        [...mine.artifacts.map((r) => r.r2_key), other.artifact.r2_key],
        [RUN],
      );
    });

    it("refuses before sending any request that changes state", async () => {
      const { f, other, receipt, recordCleaner, artifactCleaner } =
        await prepared();
      const refusals: Array<[string, string, () => Promise<unknown>]> = [
        [
          "record absent from receipt",
          "not-in-receipt:rehearsal/run-0002/main",
          () =>
            cleanFromReceipt(f, receipt, "records", recordCleaner.token, {
              requested: { records: [`rehearsal/${OTHER_RUN}/main`] },
            }),
        ],
        [
          "lineage absent from receipt",
          `not-in-receipt:${other.lineage}`,
          () =>
            cleanFromReceipt(f, receipt, "artifacts", artifactCleaner.token, {
              requested: { lineages: [other.lineage] },
            }),
        ],
        [
          "other project",
          "project",
          () =>
            cleanFromReceipt(
              f,
              { ...receipt, project_id: "someone-elses-project" },
              "artifacts",
              artifactCleaner.token,
            ),
        ],
        [
          "other deployment",
          "deployment",
          () =>
            cleanFromReceipt(
              f,
              { ...receipt, instance_id: "another-deployment" },
              "artifacts",
              artifactCleaner.token,
            ),
        ],
        [
          "credential is not a reviewed cleanup principal",
          "principal",
          () =>
            cleanFromReceipt(
              f,
              {
                ...receipt,
                cleanup_principal_ids: [artifactCleaner.principalId],
              },
              "records",
              recordCleaner.token,
            ),
        ],
        [
          "receipt names no cleanup principal",
          "principal",
          () =>
            cleanFromReceipt(
              f,
              { ...receipt, cleanup_principal_ids: [] },
              "artifacts",
              artifactCleaner.token,
            ),
        ],
        [
          "record state uncertain (cannot be read)",
          `uncertain:rehearsal/${OTHER_RUN}/main`,
          () =>
            cleanFromReceipt(
              f,
              {
                ...receipt,
                records: [{ type: "rehearsal", key: `${OTHER_RUN}/main` }],
              },
              "records",
              recordCleaner.token,
            ),
        ],
      ];
      for (const [label, reason, attempt] of refusals) {
        const error = await attempt().then(
          () => null,
          (e: unknown) => e,
        );
        expect(error, label).toBeInstanceOf(Refused);
        expect((error as Refused).reason, label).toBe(reason);
        // Refused before a claim, archive, delete or destroy was sent.
        expect((error as Refused).mutations, label).toEqual([]);
      }
      await untouched(f, [other.artifact.r2_key]);
    });

    it("rejects a receipt that repeats a record, lineage or revision key before any request", async () => {
      const { f, mine, other, receipt, recordCleaner, artifactCleaner } =
        await prepared();
      const [first, second] = mine.artifacts;
      const item = receipt.artifacts[0];
      const cases: Array<[string, string, RunReceipt]> = [
        [
          // Two entries agree with a live set of two, yet `second` is live and
          // unlisted: a length check would have retired it.
          "repeated revision key",
          `duplicate-revision:${first.r2_key}`,
          { ...receipt, artifacts: [{ ...item, revisions: [first, first] }] },
        ],
        [
          "revision key listed under two lineages",
          `duplicate-revision:${first.r2_key}`,
          {
            ...receipt,
            artifacts: [
              item,
              {
                lineage_id: other.lineage,
                revisions: [first],
                destroy_lineage: false,
              },
            ],
          },
        ],
        [
          "repeated lineage",
          `duplicate-lineage:${mine.lineage}`,
          { ...receipt, artifacts: [item, item] },
        ],
        [
          "lineage with no revisions",
          `empty-lineage:${mine.lineage}`,
          { ...receipt, artifacts: [{ ...item, revisions: [] }] },
        ],
        [
          "repeated revision number",
          `duplicate-revision-number:${mine.lineage}/${first.revision}`,
          {
            ...receipt,
            artifacts: [
              {
                ...item,
                revisions: [first, { ...second, revision: first.revision }],
              },
            ],
          },
        ],
        [
          "repeated record",
          `duplicate-record:rehearsal/${RUN}/main`,
          { ...receipt, records: [receipt.records[0], receipt.records[0]] },
        ],
      ];
      for (const [label, reason, candidate] of cases)
        for (const [phase, token] of [
          ["records", recordCleaner.token],
          ["artifacts", artifactCleaner.token],
        ] as const) {
          const error = await cleanFromReceipt(f, candidate, phase, token).then(
            () => null,
            (e: unknown) => e,
          );
          expect(error, `${label}/${phase}`).toBeInstanceOf(Refused);
          expect((error as Refused).reason, `${label}/${phase}`).toBe(reason);
          // Not even a claim: refused before anything changed state.
          expect((error as Refused).mutations, `${label}/${phase}`).toEqual([]);
        }
      // Both live revisions, including the unlisted one, are still available.
      const probe = client(f, artifactCleaner.token, "probe");
      for (const rev of mine.artifacts)
        expect(
          (await probe.artifacts.meta(rev.r2_key)).pointer.tombstoned,
        ).toBeFalsy();
      await untouched(f, [
        ...mine.artifacts.map((r) => r.r2_key),
        other.artifact.r2_key,
      ]);
    });

    it("compares actual key sets, not counts, when retiring a lineage", () => {
      const pointer = (
        rev: number,
        extra: Partial<LivePointer> = {},
      ): LivePointer => ({
        r2_key: `k${rev}`,
        lineage_id: "L",
        revision: rev,
        sha256: `sha-${rev}`,
        ...extra,
      });
      const item = (revs: number[]): ReceiptArtifact => ({
        lineage_id: "L",
        destroy_lineage: true,
        revisions: revs.map((rev) => ({
          r2_key: `k${rev}`,
          revision: rev,
          sha256: `sha-${rev}`,
        })),
      });
      // Same length as the live set, but `k2` is not listed.
      expect(lineageRefusal(item([1, 1]), [pointer(1), pointer(2)])).toBe(
        "lineage-not-exclusive:L",
      );
      expect(lineageRefusal(item([1, 2]), [pointer(1), pointer(2)])).toBeNull();
      expect(lineageRefusal(item([1]), [pointer(1), pointer(2)])).toBe(
        "lineage-not-exclusive:L",
      );
      // An unlisted revision that is already unavailable does not block it.
      expect(
        lineageRefusal(item([1]), [pointer(1), pointer(2, { tombstoned: 1 })]),
      ).toBeNull();
      expect(
        lineageRefusal(item([1]), [
          pointer(1),
          pointer(2, { blob_deleted_at: 5 }),
        ]),
      ).toBeNull();
    });

    it("refuses, under the claims, a receipt that no longer matches live artifacts", async () => {
      const { f, worker, mine, other, receipt, artifactCleaner } =
        await prepared();
      const wrongSha = {
        ...receipt,
        artifacts: [
          {
            ...receipt.artifacts[0],
            revisions: [
              { ...mine.artifacts[0], sha256: "0".repeat(64) },
              mine.artifacts[1],
            ],
          },
        ],
      };
      const wrongLineage = {
        ...receipt,
        artifacts: [
          {
            lineage_id: mine.lineage,
            revisions: [other.artifact],
            destroy_lineage: false,
          },
        ],
      };
      for (const [label, candidate] of [
        ["revision identity mismatch", wrongSha],
        ["key belongs to a different lineage", wrongLineage],
      ] as const) {
        const error = await cleanFromReceipt(
          f,
          candidate,
          "artifacts",
          artifactCleaner.token,
        ).then(
          () => null,
          (e: unknown) => e,
        );
        expect(error, label).toBeInstanceOf(Refused);
        expect((error as Refused).reason, label).toMatch(/^mismatch:/);
        expect((error as Refused).destructive, label).toEqual([]);
        // The claim it took was released again: the run can take it.
        const w = client(f, worker.token, "probe");
        const probe = await w.claims.acquire(
          `artifact:${mine.lineage}`,
          "exclusive",
          60_000,
        );
        await w.claims.release(`artifact:${mine.lineage}`, probe.fence);
      }
      await untouched(f, [
        ...mine.artifacts.map((r) => r.r2_key),
        other.artifact.r2_key,
      ]);
    });

    it("refuses to retire a lineage a writer extended before the cleaner took the claim", async () => {
      const { f, mine, other, receipt, artifactCleaner } = await prepared();
      // The receipt was reviewed while the lineage held exactly its revisions.
      // A writer then appends and releases before the cleaner acquires.
      let appended: ReceiptRevision | undefined;
      const error = await cleanFromReceipt(
        f,
        receipt,
        "artifacts",
        artifactCleaner.token,
        {
          hooks: {
            beforeClaims: async () => {
              appended = await mine.append("written after review");
            },
          },
        },
      ).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Refused);
      expect((error as Refused).reason).toBe(
        `lineage-not-exclusive:${mine.lineage}`,
      );
      expect((error as Refused).destructive).toEqual([]);
      if (!appended) throw new Error("hook did not run");
      await drain(f);
      await untouched(f, [
        ...mine.artifacts.map((r) => r.r2_key),
        appended.r2_key,
        other.artifact.r2_key,
      ]);
    });

    it("removes only receipt revisions when per-revision mode meets a newer append", async () => {
      const { f, mine, receipt, artifactCleaner } = await prepared();
      const perRevision: RunReceipt = {
        ...receipt,
        artifacts: [{ ...receipt.artifacts[0], destroy_lineage: false }],
      };
      let appended: ReceiptRevision | undefined;
      const result = await cleanFromReceipt(
        f,
        perRevision,
        "artifacts",
        artifactCleaner.token,
        {
          hooks: {
            beforeClaims: async () => {
              appended = await mine.append("newer than the receipt");
            },
          },
        },
      );
      expect(result.done).toEqual([`artifact:${mine.lineage}`]);
      expect(result.c.destructive()).toHaveLength(mine.artifacts.length);
      if (!appended) throw new Error("hook did not run");
      await drain(f);
      for (const rev of mine.artifacts)
        expect(await bindings.ARTIFACTS.get(rev.r2_key)).toBeNull();
      expect(await bindings.ARTIFACTS.get(appended.r2_key)).not.toBeNull();
    });

    it("excludes writers between verification and the destructive call", async () => {
      const { f, worker, mine, receipt, artifactCleaner } = await prepared();
      const w = client(f, worker.token, "competing-writer");
      const resource = `artifact:${mine.lineage}`;
      const result = await cleanFromReceipt(
        f,
        receipt,
        "artifacts",
        artifactCleaner.token,
        {
          hooks: {
            afterClaims: async () => {
              // The lineage claim is exclusive: a writer cannot take it, and
              // its earlier fence no longer authorises an append.
              const blocked = await failure(
                w.claims.acquire(resource, "exclusive", 60_000),
              );
              expect(blocked.status).toBe(409);
              const stale = await failure(
                writeRevision(f, w, mine.lineage, mine.claim.fence, "sneaky"),
              );
              expect(stale.status).toBe(409);
            },
          },
        },
      );
      expect(result.done).toEqual([`artifact:${mine.lineage}`]);
      expect(result.c.destructive()).toHaveLength(1);
      await drain(f);
      for (const rev of mine.artifacts)
        expect(await bindings.ARTIFACTS.get(rev.r2_key)).toBeNull();
    });
  });
});
