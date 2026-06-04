import { TableCell, TableRow } from "@/components/ui/table";

function SkeletonBar({ className }: { className?: string }) {
  return (
    <span
      className={`inline-block animate-pulse rounded bg-border-soft ${className ?? "h-3 w-24"}`}
    />
  );
}

export function TableSkeleton({
  rows = 5,
  columns = 4,
}: {
  rows?: number;
  columns?: number;
}) {
  const widths = ["w-32", "w-16", "w-20", "w-24", "w-14", "w-28"];
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
        <TableRow key={r}>
          {Array.from({ length: columns }, (_, c) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <TableCell key={c}>
              <SkeletonBar className={`h-3 ${widths[c % widths.length]}`} />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}
