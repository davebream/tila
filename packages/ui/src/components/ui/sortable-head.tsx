import { cn } from "@/lib/utils";
import type * as React from "react";
import { useState } from "react";

export type SortDir = "asc" | "desc";
export type SortState<K extends string = string> = {
  key: K;
  dir: SortDir;
} | null;

export function useSort<K extends string>(
  initial: SortState<K> = null,
): [SortState<K>, (key: K) => void] {
  const [sort, setSort] = useState<SortState<K>>(initial);

  function toggle(key: K) {
    setSort((prev) => {
      if (prev?.key === key) {
        return prev.dir === "desc" ? { key, dir: "asc" } : null;
      }
      return { key, dir: "desc" };
    });
  }

  return [sort, toggle];
}

export function SortableHead({
  sortKey,
  active,
  dir,
  onSort,
  className,
  children,
  ...props
}: {
  sortKey: string;
  active: boolean;
  dir?: SortDir | null;
  onSort: (key: string) => void;
} & Omit<React.ComponentProps<"th">, "onClick" | "dir">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "group/sortable h-(--density-row) px-(--density-cell-x) py-(--density-cell-y) text-left align-middle text-[10px] font-semibold uppercase tracking-[0.08em] whitespace-nowrap text-muted-foreground cursor-pointer select-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal-blue",
        className,
      )}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: th needs tabIndex for keyboard sort activation
      tabIndex={0}
      onClick={() => onSort(sortKey)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSort(sortKey);
        }
      }}
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      {...props}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {active ? (
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="currentColor"
            aria-hidden="true"
          >
            {dir === "asc" ? (
              <path d="M5 2L8.5 7H1.5L5 2Z" />
            ) : (
              <path d="M5 8L1.5 3H8.5L5 8Z" />
            )}
          </svg>
        ) : (
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="currentColor"
            aria-hidden="true"
            className="opacity-20 transition-opacity group-hover/sortable:opacity-40"
          >
            <path d="M5 1.5L7.5 4.5H2.5Z" />
            <path d="M5 8.5L2.5 5.5H7.5Z" />
          </svg>
        )}
      </span>
    </th>
  );
}
