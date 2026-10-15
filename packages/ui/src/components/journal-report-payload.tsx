import { TableCell, TableRow } from "@/components/ui/table";
import { reportPayloadFields } from "@/lib/report-payload";
import { useMemo } from "react";

/**
 * The readable text of a project report, as a row under the report's own.
 *
 * Journal-only: task history shows `ProjectReportDetails` on its own and is
 * unchanged. Live rows and replay-loaded rows both come through here, so they
 * cannot present a report differently. Raw JSON stays behind the row's data
 * toggle, untouched.
 */
export function ReportPayloadRow({
  seq,
  data,
  colSpan,
}: {
  seq: number;
  /** The journal event's `data`: the append request, payload under `data`. */
  data: Record<string, unknown>;
  colSpan: number;
}) {
  const fields = useMemo(() => reportPayloadFields(data), [data]);
  if (fields.length === 0) return null;
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="py-2">
        <section aria-label={`Report text for event #${seq}`}>
          <dl className="space-y-3 text-sm">
            {fields.map((field) => (
              <div key={field.key}>
                <dt className="font-mono text-[11px] text-muted-foreground">
                  {field.key}
                </dt>
                <dd className="mt-1 break-words">
                  {field.kind === "markdown" ? (
                    <div
                      className="tila-prose"
                      // biome-ignore lint/security/noDangerouslySetInnerHtml: report text is caller-supplied; renderMarkdown's untrusted profile shows raw HTML as text and allowlists the rest
                      dangerouslySetInnerHTML={{ __html: field.html }}
                    />
                  ) : (
                    <pre className="overflow-x-auto rounded-md bg-card p-2 text-xs text-foreground whitespace-pre-wrap break-all">
                      {field.text}
                    </pre>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </TableCell>
    </TableRow>
  );
}
