import { Button } from "@/components/ui/button";
import type { CursorPaging } from "@/hooks/use-cursor-paging";

/** Previous (or First page for a deep link), position, Next. */
export function PageNav({
  paging,
  nextCursor,
  position,
  label,
  nextLabel = "Next",
}: {
  paging: CursorPaging;
  nextCursor: string | null;
  position?: string | null;
  label: string;
  nextLabel?: string;
}) {
  if (!paging.after && !nextCursor) return null;
  return (
    <nav
      aria-label={label}
      className="flex flex-wrap items-center gap-3 font-mono text-[11px] text-muted-foreground"
    >
      {paging.after &&
        (paging.canGoPrevious ? (
          <Button variant="ghost" size="sm" onClick={paging.goPrevious}>
            Previous
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={paging.goFirst}>
            First page
          </Button>
        ))}
      {position && <span className="tila-num">{position}</span>}
      {nextCursor && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => paging.goNext(nextCursor)}
        >
          {nextLabel}
        </Button>
      )}
    </nav>
  );
}
