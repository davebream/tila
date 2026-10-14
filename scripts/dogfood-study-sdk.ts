/**
 * Thin, logged-by-the-caller wrapper over the public local SDK facade, for the #194 pilot.
 *
 * It adds no behaviour: no retry, reassignment or recovery logic. It exists because handoffs
 * and reentry have no local CLI surface, and because the CLI's `task claim` mis-reports a lost
 * claim; the facade throws 409 already-held, which is surfaced here unchanged.
 *
 * Usage (run through tsx so the workspace source is resolved):
 *   tsx --tsconfig tsconfig.json scripts/dogfood-study-sdk.ts <store.json> <participant> <verb> [args]
 * where store.json is { dbPath, artifactsPath, org, project }. Prints one JSON object.
 */
import { readFileSync } from "node:fs";
import { buildLocalResources, createTilaLocal } from "tila-sdk/local";

interface Store {
  dbPath: string;
  artifactsPath: string;
  org: string;
  project: string;
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

function flags(args: string[], name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === `--${name}` && args[i + 1] !== undefined) out.push(args[i + 1]);
  });
  return out;
}

function fail(kind: string, message: string, status?: number): never {
  console.log(JSON.stringify({ ok: false, error: { kind, message, status } }));
  process.exit(1);
}

const [storeFile, participant, verb, ...rest] = process.argv.slice(2);
if (!storeFile || !participant || !verb)
  fail("usage", "store, participant and verb are required");
const store = JSON.parse(readFileSync(storeFile, "utf8")) as Store;

const local = await createTilaLocal({
  dbPath: store.dbPath,
  artifactsPath: store.artifactsPath,
  org: store.org,
  project: store.project,
  skipFilesystemCheck: true,
  identity: {
    principal_id: `local:${store.org}`,
    participant_id: participant,
    environment: { client_name: "dogfood-study" },
  },
});

try {
  const api = buildLocalResources(local.project, local.artifacts);
  const ttl = Number(flag(rest, "ttl-ms") ?? 120000);
  switch (verb) {
    case "claim": {
      const resource = rest[0];
      const result = await api.claims.acquire(resource, "exclusive", ttl);
      console.log(
        JSON.stringify({
          ok: true,
          resource,
          fence: result.fence,
          expires_at: result.expires_at,
          participant_id: result.participant_id,
        }),
      );
      break;
    }
    case "renew": {
      const result = await api.claims.renew(
        rest[0],
        Number(flag(rest, "fence")),
        ttl,
      );
      console.log(
        JSON.stringify({
          ok: true,
          resource: rest[0],
          fence: result.fence,
          expires_at: result.expires_at,
        }),
      );
      break;
    }
    case "release": {
      await api.claims.release(rest[0], Number(flag(rest, "fence")));
      console.log(JSON.stringify({ ok: true, resource: rest[0] }));
      break;
    }
    case "handoff-create": {
      const replay = await api.journal.replay({ after_seq: 0, limit: 1 });
      const refs = flags(rest, "ref").map((ref) => {
        const [type, id] = ref.split(":");
        return type === "task"
          ? { type: "task" as const, id }
          : { type: "artifact" as const, key: id };
      });
      const created = await api.handoffs.create({
        id: crypto.randomUUID(),
        summary: flag(rest, "summary") ?? "",
        based_on_seq: replay.through_seq,
        references: refs,
      });
      console.log(
        JSON.stringify({
          ok: true,
          handoff_id: created.handoff.id,
          created_seq: created.handoff.created_seq,
        }),
      );
      break;
    }
    case "handoff-list": {
      const list = await api.handoffs.list({});
      console.log(JSON.stringify({ ok: true, handoffs: list.handoffs }));
      break;
    }
    case "reentry": {
      const handoffId = flag(rest, "handoff-id");
      const result = await api.reentry(
        handoffId ? { handoff_id: handoffId } : {},
      );
      console.log(
        JSON.stringify({
          ok: true,
          handoff: result.handoff ?? null,
          active_claims: result.active_claims,
          changes: result.changes,
        }),
      );
      break;
    }
    case "journal-dump": {
      const rows: unknown[] = [];
      let after = 0;
      for (let page = 0; page < 200; page += 1) {
        const replay = await api.journal.replay({
          after_seq: after,
          limit: 200,
        });
        rows.push(...replay.events);
        if (!replay.has_more) break;
        after = replay.next_after_seq;
      }
      console.log(JSON.stringify({ ok: true, events: rows }));
      break;
    }
    default:
      fail("usage", `unknown verb ${verb}`);
  }
} catch (error) {
  const e = error as { status?: number; code?: string; message?: string };
  fail(e.code ?? "error", e.message ?? String(error), e.status);
} finally {
  local.close();
}
