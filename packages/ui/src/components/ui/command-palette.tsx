import { Badge } from "@/components/ui/badge";
import { Kbd } from "@/components/ui/kbd";
import { useTasks } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

interface PaletteItem {
  id: string;
  label: string;
  meta?: string;
  group: string;
  href: string;
  badge?: { text: string; variant: "default" | "green" | "amber" | "gray" };
}

export function CommandPalette({
  open,
  onClose,
}: { open: boolean; onClose: () => void }) {
  const { projectId } = useAuth();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: taskData } = useTasks();
  const entities = taskData?.entities ?? [];

  const items = useMemo(() => {
    const q = query.toLowerCase().trim();
    const result: PaletteItem[] = [];
    const prefix = projectId ? `/p/${projectId}` : "";

    for (const e of entities) {
      if (
        q &&
        !e.id.toLowerCase().includes(q) &&
        !e.type.toLowerCase().includes(q)
      )
        continue;
      result.push({
        id: e.id,
        label: e.id,
        meta: e.type,
        group: "tasks",
        href: `${prefix}/tasks/${e.id}`,
        badge: { text: e.type, variant: "gray" },
      });
    }

    const pages: PaletteItem[] = [
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
        meta: "Which machines are online right now",
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
  }, [entities, query, projectId]);

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

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const prevQueryRef = useRef(query);
  if (prevQueryRef.current !== query) {
    prevQueryRef.current = query;
    setSelectedIndex(0);
  }

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
    } else if (e.key === "Tab") {
      e.preventDefault();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, flatItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = flatItems[selectedIndex];
      if (item) go(item);
    }
  }

  if (!open) return null;

  let flatIndex = -1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[80px]"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: scrim is a backdrop, keyboard close is handled by Escape on the palette container */}
      <div
        className="absolute inset-0 bg-background/70"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* palette */}
      <div
        className="relative z-10 mx-4 flex w-full max-w-[640px] max-h-[480px] flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-overlay"
        onKeyDown={handleKeyDown}
      >
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
                      onMouseEnter={() => setSelectedIndex(idx)}
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
    </div>
  );
}
