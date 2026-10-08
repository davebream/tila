import { pseudoRandomBytes, timed } from "../measure";
import type {
  OpOutcome,
  Participant,
  Scenario,
  ScenarioContext,
} from "../types";

const KIND = "bench";
const LIST_EVERY = 5;

interface State {
  counters: Map<number, number>;
  keys: string[];
  payloads: Map<number, Uint8Array>;
}
const states = new Map<string, State>();
const stateOf = (ctx: ScenarioContext): State => {
  let s = states.get(ctx.runId);
  if (!s) {
    s = { counters: new Map(), keys: [], payloads: new Map() };
    states.set(ctx.runId, s);
  }
  return s;
};

/** Same byte length as the binary payload, restricted to printable ASCII. */
function textOf(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++)
    out += String.fromCharCode(32 + (bytes[i] % 95));
  return out;
}

export function sizeLabel(bytes: number): string {
  if (bytes >= 1_048_576 && bytes % 1_048_576 === 0)
    return `${bytes / 1_048_576}m`;
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024}k`;
  return `${bytes}b`;
}

/** Upload blobs of representative sizes, read metadata back, list periodically. */
export const artifacts: Scenario = {
  name: "artifacts",
  description:
    "Artifact upload (no claim; sizes round-robin), metadata read-back, and a periodic kind-filtered list. The embedded tier writes text blobs via writeText.",
  tiers: ["inproc", "embedded", "http"],
  async setup(ctx) {
    const s = stateOf(ctx);
    ctx.extra.meta_size_mismatches = 0;
    ctx.extra.bytes_uploaded = 0;
    for (const size of ctx.params.sizesBytes)
      s.payloads.set(size, pseudoRandomBytes(size, ctx.seed + size));
  },
  async op(ctx, p) {
    const s = stateOf(ctx);
    const i = s.counters.get(p.index) ?? 0;
    s.counters.set(p.index, i + 1);
    const sizes = ctx.params.sizesBytes;
    const size = sizes[(p.index + i) % sizes.length];
    const base =
      s.payloads.get(size) ?? pseudoRandomBytes(size, ctx.seed + size);
    // Vary the first bytes so content addressing does not dedupe every upload.
    const bytes = new Uint8Array(base);
    const stamp = `${ctx.runId}:${p.index}:${i}`;
    for (let k = 0; k < Math.min(stamp.length, bytes.length); k++)
      bytes[k] = stamp.charCodeAt(k);
    const out: OpOutcome[] = [];
    // Local mode has no multipart upload; it writes text blobs of the same
    // size through the JSON text route instead (documented tier difference).
    const upload = await timed(`upload_${sizeLabel(size)}`, () =>
      ctx.tier === "embedded"
        ? p.tila.artifacts.writeText(textOf(bytes), {
            kind: KIND,
            mimeType: "text/plain",
            tags: [`bench:${ctx.runId}`],
          })
        : p.tila.artifacts.upload(new Blob([bytes]), {
            kind: KIND,
            mimeType: "application/octet-stream",
            tags: [`bench:${ctx.runId}`],
          }),
    );
    out.push(upload);
    if (upload.cls !== "ok" || !upload.value) return out;
    ctx.extra.bytes_uploaded += size;
    const key = upload.value.key;
    s.keys.push(key);
    const meta = await timed("meta", () => p.tila.artifacts.meta(key));
    out.push(meta);
    if (meta.cls === "ok" && meta.value && meta.value.pointer.bytes !== size)
      ctx.extra.meta_size_mismatches++;
    if (i % LIST_EVERY === 0)
      out.push(
        await timed("list", () =>
          p.tila.artifacts.list({ kind: KIND, limit: "50" }),
        ),
      );
    return out;
  },
  async teardown(ctx) {
    const s = stateOf(ctx);
    const p = ctx.participants[0];
    if (!p) return;
    for (const key of s.keys) {
      try {
        await p.tila.artifacts.delete(key);
      } catch {
        // best effort; deployed runs destroy the throwaway project anyway
      }
    }
  },
  dataset(ctx) {
    return {
      sizes_bytes: ctx.params.sizesBytes,
      list_every: LIST_EVERY,
      kind: KIND,
    };
  },
  invariants(ctx, rec) {
    return [
      { name: "no errors", ok: rec.total("error") === 0 },
      {
        name: "metadata byte counts match uploads",
        ok: ctx.extra.meta_size_mismatches === 0,
      },
    ];
  },
};
