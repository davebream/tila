import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";

// Schema-aware rendering of stored task data and record values.

export function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <TableCell className="w-40 font-sans text-sm font-medium text-muted-foreground">
      {children}
    </TableCell>
  );
}

function NotSet() {
  return <span className="font-sans text-muted-foreground">Not set</span>;
}

/**
 * One stored value, rendered by its declared type. A value whose shape does
 * not match the declaration is shown as stored rather than coerced.
 */
export function FieldValue({ value, type }: { value: unknown; type?: string }) {
  if (value === undefined || value === null) return <NotSet />;
  if (typeof value === "string") {
    if (value === "") {
      return <span className="font-sans text-muted-foreground">Empty</span>;
    }
    if (type === "enum") return <Badge variant="gray">{value}</Badge>;
    if (type === "text") {
      return (
        <span className="whitespace-pre-wrap font-sans text-foreground">
          {value}
        </span>
      );
    }
    return (
      <span className="whitespace-pre-wrap break-words text-foreground">
        {value}
      </span>
    );
  }
  if (typeof value === "number") {
    return <span className="tila-num text-foreground">{value}</span>;
  }
  if (typeof value === "boolean") {
    return <span className="text-foreground">{value ? "Yes" : "No"}</span>;
  }
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    if (value.length === 0) {
      return <span className="font-sans text-muted-foreground">None</span>;
    }
    return (
      <span className="flex flex-wrap gap-1">
        {value.map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: list items may repeat
          <Badge key={`${item}-${i}`} variant="secondary">
            {item}
          </Badge>
        ))}
      </span>
    );
  }
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-background p-2 text-xs text-foreground">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function FieldTable({
  label,
  rows,
}: {
  label: string;
  rows: { name: string; value: unknown; type?: string }[];
}) {
  return (
    <div className="border-t border-border">
      <Table aria-label={label}>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.name}>
              <FieldLabel>
                <span className="font-mono">{row.name}</span>
              </FieldLabel>
              <TableCell>
                <FieldValue value={row.value} type={row.type} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function MutedLine({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

export function DefinitionsUnavailable({ onRetry }: { onRetry?: () => void }) {
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-tint-amber px-3 py-2 text-xs text-status-amber">
      <span>
        Field definitions unavailable. Stored data is shown without its schema.
      </span>
      {onRetry && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onRetry}
          className="font-mono text-muted-foreground"
        >
          Retry
        </Button>
      )}
    </p>
  );
}

/** Stored keys as field rows, in stored order, minus `exclude`. */
export function dataRows(
  data: Record<string, unknown>,
  exclude: Iterable<string> = [],
) {
  const skip = new Set(exclude);
  return Object.keys(data)
    .filter((key) => !skip.has(key))
    .map((key) => ({ name: key, value: data[key] }));
}

/** Raw JSON, collapsed until asked for. */
export function CollapsibleData({
  data,
  noun = "data",
}: {
  data: Record<string, unknown>;
  noun?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          size={14}
          className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        />
        Show {noun} ({Object.keys(data).length} keys)
      </button>
      {open && (
        <pre className="mt-2 overflow-x-auto rounded-md bg-background p-3 text-xs text-foreground whitespace-pre-wrap break-all">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}
