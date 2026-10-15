import { renderMarkdown } from "@/lib/markdown";

/**
 * One top-level field of a project report's payload, ready to show.
 *
 * `markdown` is sanitized HTML for a non-blank string. `json` is plain text
 * for everything else (numbers, booleans, null, arrays, objects, blank
 * strings): the value as JSON, never interpreted, so no value is dropped.
 */
export type ReportPayloadField =
  | { key: string; kind: "markdown"; html: string }
  | { key: string; kind: "json"; text: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The readable fields of a `custom.reported` journal event.
 *
 * `eventData` is the event's `data`, which is the append request: report
 * metadata (`event_name`, `target`, ...) plus the caller's payload under
 * `data`. Only that payload is reported here. Its top-level string fields are
 * markdown; strings nested inside arrays or objects stay literal JSON text, so
 * nested structure is shown exactly as sent rather than guessed at.
 */
export function reportPayloadFields(
  eventData: Record<string, unknown>,
): ReportPayloadField[] {
  const payload = eventData.data;
  if (!isRecord(payload)) return [];
  return Object.entries(payload).map(([key, value]) =>
    typeof value === "string" && value.trim() !== ""
      ? {
          key,
          kind: "markdown",
          html: renderMarkdown(value, { untrusted: true }),
        }
      : { key, kind: "json", text: JSON.stringify(value, null, 2) },
  );
}
