import { z } from "zod";
import { TagsSchema } from "./tags";

// --- Record identity schemas ---

export const RecordTypeSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_-]*$/,
    "Record type must start with lowercase letter and contain only lowercase letters, digits, underscores, and hyphens",
  );

export type RecordType = z.infer<typeof RecordTypeSchema>;

export const RecordKeySchema = z.string().superRefine((val, ctx) => {
  if (val.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Record key must not be empty",
    });
    return;
  }
  if (val.length > 256) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Record key must not exceed 256 characters",
    });
    return;
  }
  const segments = val.split("/");
  if (segments.some((s) => s === "")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "Record key must not have empty segments (no leading slash, trailing slash, or consecutive slashes)",
    });
    return;
  }
  if (segments.length > 8) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Record key must not exceed 8 segments",
    });
    return;
  }
  for (const seg of segments) {
    if (seg.length > 64) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Segment "${seg}" exceeds 64 characters`,
      });
      return;
    }
    if (seg === "." || seg === "..") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Segment "${seg}" is reserved`,
      });
      return;
    }
    if (seg.startsWith(".") || seg.startsWith("_")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Segment "${seg}" must not start with '.' or '_'`,
      });
      return;
    }
    if (seg.includes("~")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Segment "${seg}" must not contain '~'`,
      });
      return;
    }
    if (seg.includes(":")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Segment "${seg}" must not contain ':'`,
      });
      return;
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(seg)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Segment "${seg}" contains invalid characters`,
      });
      return;
    }
  }
});

export type RecordKey = z.infer<typeof RecordKeySchema>;

export const RecordTagSchema = TagsSchema;

export type RecordTag = z.infer<typeof RecordTagSchema>;

// --- Resource name helpers ---

export function formatRecordResource(type: string, key: string): string {
  return `record:${type}/${key}`;
}

export function parseRecordResource(
  resource: string,
): { type: string; key: string } | null {
  if (!resource.startsWith("record:")) return null;
  const rest = resource.slice(7); // "record:".length === 7
  const slashIndex = rest.indexOf("/");
  if (slashIndex === -1) return null;
  return {
    type: rest.slice(0, slashIndex),
    key: rest.slice(slashIndex + 1),
  };
}

// --- Canonical JSON helpers ---

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v !== null && typeof v === "object") {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      sorted[k] = sortKeysDeep((v as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return v;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

export async function canonicalJsonSha256(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(canonicalJson(value));
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// --- Record value schema ---

const MAX_RECORD_VALUE_BYTES = 65536; // 64 KiB

export const RecordValueSchema = z.record(z.unknown()).refine((value) => {
  const canonical = canonicalJson(value);
  return new TextEncoder().encode(canonical).length <= MAX_RECORD_VALUE_BYTES;
}, "Record value exceeds 64 KiB canonical JSON limit");

export type RecordValue = z.infer<typeof RecordValueSchema>;
