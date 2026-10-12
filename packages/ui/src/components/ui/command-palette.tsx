import { Badge } from "@/components/ui/badge";
import { Kbd } from "@/components/ui/kbd";
import {
  TASK_SEARCH_MIN_LENGTH,
  useRecentTasks,
  useTaskSearch,
  useWorkCatalog,
} from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { useDebouncedValue } from "@/hooks/use-debounce";
import { catalogIndex, taskTitle } from "@/lib/presentation";
import { classifyApiError } from "@/lib/query-state";
import { Dialog } from "radix-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

interface PaletteItem {
  id: string;
  label: string;
  /** Secondary mono text, e.g. the task id when the label is its title. */
  detail?: string;
  meta?: string;
  group: string;
  href: string;
  badge?: { text: string; variant: "default" | "green" | "amber" | "gray" };
}

const SEARCH_LIMIT = 20;

export function CommandPalette({
  open,
  onClose,
}: { open: boolean; onClose: () => void }) {
  const { projectId } = useAuth();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  // Highlight is tracked by item id so it survives results refreshing.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const trimmed = query.trim();
  const debounced = useDebouncedValue(trimmed, 200);
  const wantsSearch = trimmed.length >= TASK_SEARCH_MIN_LENGTH;

  const recentQuery = useRecentTasks({ enabled: open });
  const catalogQuery = useWorkCatalog({ enabled: open });
  const searchQuery = useTaskSearch(
    { q: debounced, limit: SEARCH_LIMIT },
    { enabled: open && wantsSearch },
  );
  const searchFailed =
    wantsSearch && searchQuery.isError && searchQuery.data === undefined;
  // A credential that may not search simply gets no task results.
  const searchForbidden =
    searchFailed && classifyApiError(searchQuery.error) === "forbidden";

  const items = useMemo(() => {
    const q = trimmed.toLowerCase();
    const result: PaletteItem[] = [];
    const prefix = projectId ? `/p/${projectId}` : "";
    const entries = catalogIndex(catalogQuery.data?.types);

    if (!q) {
      for (const e of recentQuery.data?.entities ?? []) {
        const title = taskTitle(e.data, entries.get(e.type));
        result.push({
          id: `task:${e.id}`,
          label: title ?? e.id,
          detail: title ? e.id : undefined,
          group: "recent tasks",
          href: `${prefix}/tasks/${e.id}`,
          badge: { text: e.type, variant: "gray" },
        });
      }
    } else if (wantsSearch && !searchFailed) {
      // Results for an older query stay visible while the new one loads.
      const showResults =
        debounced.length >= TASK_SEARCH_MIN_LENGTH && searchQuery.data;
      for (const r of showResults ? searchQuery.data.results : []) {
        if (r.type !== "entity") continue;
        result.push({
          id: `task:${r.entity_id}`,
          label: r.name ?? r.entity_id,
          detail: r.name ? r.entity_id : undefined,
          group: "tasks",
          href: `${prefix}/tasks/${r.entity_id}`,
          badge: { text: r.entity_type, variant: "gray" },
        });
      }
      result.push({
        id: "search-all-tasks",
        label: `Search all tasks for “${trimmed}”`,
        group: "tasks",
        href: `${prefix}/tasks?q=${encodeURIComponent(trimmed)}`,
      });
    }

    const pages: PaletteItem[] = [
      {
        id: "nav:rooms",
        label: "Go to Rooms",
        group: "navigation",
        href: `${prefix}/rooms`,
      },
      {
        id: "nav:agents",
        label: "Go to Agents",
        group: "navigation",
        href: `${prefix}/agents`,
      },
      {
        id: "nav:runtime",
        label: "Go to Runtime",
        group: "navigation",
        href: `${prefix}/runtime`,
      },
      {
        id: "nav:tasks",
        label: "Go to Tasks",
        group: "navigation",
        href: `${prefix}/tasks`,
      },
      {
        id: "nav:records",
        label: "Go to Records",
        group: "navigation",
        href: `${prefix}/records`,
      },
      {
        id: "nav:journal",
        label: "Go to Journal",
        group: "navigation",
        href: `${prefix}/journal`,
      },
      {
        id: "nav:presence",
        label: "Go to Presence",
        group: "navigation",
        href: `${prefix}/presence`,
      },
      {
        id: "nav:artifacts",
        label: "Go to Artifacts",
        group: "navigation",
        href: `${prefix}/artifacts`,
      },
    ];

    for (const p of pages) {
      if (q && !p.label.toLowerCase().includes(q)) continue;
      result.push(p);
    }

    const shortcuts: PaletteItem[] = [
      {
        id: "shortcut:j-k",
        label: "j / k or ↑ / ↓",
        meta: "Navigate table rows",
        group: "shortcuts",
        href: "",
      },
      {
        id: "shortcut:enter",
        label: "Enter",
        meta: "Open selected task",
        group: "shortcuts",
        href: "",
      },
      {
        id: "shortcut:cmd-k",
        label: "⌘K",
        meta: "Open this palette",
        group: "shortcuts",
        href: "",
      },
    ];

    for (const s of shortcuts) {
      if (
        q &&
        !s.label.toLowerCase().includes(q) &&
        !s.meta?.toLowerCase().includes(q)
      )
        continue;
      result.push(s);
    }

    const glossary: PaletteItem[] = [
      {
        id: "glossary:task",
        label: "Task",
        meta: "Work items your agents are coordinating",
        group: "glossary",
        href: "",
      },
      {
        id: "glossary:claim",
        label: "Claim",
        meta: "Which agent currently owns each piece of work",
        group: "glossary",
        href: "",
      },
      {
        id: "glossary:fence",
        label: "Fence",
        meta: "Ensures writes happen in order; stale writes are rejected",
        group: "glossary",
        href: "",
      },
      {
        id: "glossary:artifact",
        label: "Artifact",
        meta: "Files and outputs produced during work, deduplicated by content",
        group: "glossary",
        href: "",
      },
      {
        id: "glossary:presence",
        label: "Presence",
        meta: "Which participants are online right now",
        group: "glossary",
        href: "",
      },
      {
        id: "glossary:journal",
        label: "Journal",
        meta: "Timeline of all state changes in a project",
        group: "glossary",
        href: "",
      },
    ];

    for (const g of glossary) {
      if (
        q &&
        !g.label.toLowerCase().includes(q) &&
        !g.meta?.toLowerCase().includes(q)
      )
        continue;
      result.push(g);
    }

    return result;
  }, [
    trimmed,
    debounced,
    wantsSearch,
    searchFailed,
    projectId,
    recentQuery.data,
    searchQuery.data,
    catalogQuery.data,
  ]);

  const groups = useMemo(() => {
    const map = new Map<string, PaletteItem[]>();
    for (const item of items) {
      const list = map.get(item.group) ?? [];
      list.push(item);
      map.set(item.group, list);
    }
    return map;
  }, [items]);

  const flatItems = items;
  const foundIndex = flatItems.findIndex((item) => item.id === selectedId);
  const selectedIndex = foundIndex === -1 ? 0 : foundIndex;

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedId(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const prevQueryRef = useRef(query);
  if (prevQueryRef.current !== query) {
    prevQueryRef.current = query;
    setSelectedId(null);
  }

  const selectAt = (index: number) => {
    const item = flatItems[index];
    if (item) setSelectedId(item.id);
  };

  const go = useCallback(
    (item: PaletteItem) => {
      if (!item.href) {
        onClose();
        return;
      }
      onClose();
      navigate(item.href);
    },
    [navigate, onClose],
  );

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      selectAt(Math.min(selectedIndex + 1, flatItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectAt(Math.max(selectedIndex - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = flatItems[selectedIndex];
      if (item) go(item);
    }
  }

  let flatIndex = -1;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-background/70" />
        <Dialog.Content
          aria-label="Command palette"
          onKeyDown={handleKeyDown}
          className="fixed inset-0 z-50 flex items-start justify-center pt-[80px] outline-none"
        >
          {/* palette */}
          <div className="relative z-10 mx-4 flex w-full max-w-[640px] max-h-[480px] flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-overlay">
            {/* input row */}
            <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-3">
              <span className="font-mono text-[11px] text-fg-faint">›</span>
              <input
                ref={inputRef}
                type="text"
                role="combobox"
                aria-expanded={flatItems.length > 0}
                aria-controls="command-palette-listbox"
                aria-activedescendant={
                  flatItems[selectedIndex]
                    ? `palette-item-${flatItems[selectedIndex].id}`
                    : undefined
                }
                className="flex-1 bg-transparent font-mono text-[13px] text-foreground placeholder:text-muted-foreground outline-none"
                placeholder="Search tasks, pages..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <Kbd>esc</Kbd>
            </div>

            {/* results */}
            <div
              className="flex-1 overflow-y-auto"
              id="command-palette-listbox"
              role="listbox"
              aria-label="Search results"
            >
              {searchFailed && !searchForbidden && (
                <div className="flex items-center gap-3 px-3.5 py-2 font-mono text-[12px] text-muted-foreground">
                  <span>Search unavailable</span>
                  <button
                    type="button"
                    onClick={() => void searchQuery.refetch()}
                    className="cursor-pointer rounded-sm text-signal-blue hover:text-signal-blue-hover focus-visible:outline-2 focus-visible:outline-signal-blue"
                  >
                    Retry
                  </button>
                </div>
              )}
              {flatItems.length === 0 ? (
                <div className="px-3.5 py-6 text-center font-mono text-[12px] text-muted-foreground">
                  No results
                </div>
              ) : (
                Array.from(groups.entries()).map(([group, groupItems]) => (
                  <div key={group} className="py-2">
                    <div className="tila-label px-3.5 py-1">
                      {group} · {groupItems.length}
                    </div>
                    {groupItems.map((item) => {
                      flatIndex++;
                      const idx = flatIndex;
                      const selected = idx === selectedIndex;
                      return (
                        <div
                          key={item.id}
                          id={`palette-item-${item.id}`}
                          role="option"
                          aria-selected={selected}
                          className="flex cursor-pointer items-center gap-2.5 px-3.5 py-[7px]"
                          style={{
                            background: selected
                              ? "var(--color-tint-blue-12)"
                              : "transparent",
                          }}
                          onClick={() => go(item)}
                          onKeyDown={(e) => e.key === "Enter" && go(item)}
                          onMouseEnter={() => setSelectedId(item.id)}
                        >
                          <span
                            className="flex-1 font-mono text-[12px]"
                            style={{
                              color: selected
                                ? "var(--color-fg-strong)"
                                : "var(--color-foreground)",
                            }}
                          >
                            {item.label}
                          </span>
                          {item.detail && (
                            <span className="font-mono text-[11px] text-fg-faint">
                              {item.detail}
                            </span>
                          )}
                          {item.badge && (
                            <Badge variant={item.badge.variant}>
                              {item.badge.text}
                            </Badge>
                          )}
                          {item.meta && !item.badge && (
                            <span className="font-mono text-[11px] text-fg-faint">
                              {item.meta}
                            </span>
                          )}
                          {selected && <Kbd>↵</Kbd>}
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
            </div>

            {/* footer hints */}
            <div className="flex items-center justify-between border-t border-border bg-card px-3.5 py-2">
              <div className="flex gap-3.5 font-mono text-[11px] text-fg-faint">
                <span>
                  <Kbd>↑↓</Kbd> navigate
                </span>
                <span>
                  <Kbd>↵</Kbd> open
                </span>
                <span>
                  <Kbd>esc</Kbd> close
                </span>
              </div>
              {flatItems.length > 0 && (
                <span className="tila-num font-mono text-[11px] text-fg-faint">
                  {flatItems.length} results
                </span>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
