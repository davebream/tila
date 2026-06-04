import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ChevronDown } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

export interface FilterGroup {
  label: string;
  options: string[];
}

interface MultiSelectFilterProps {
  label: string;
  options: string[];
  selected: string[];
  onChange: (values: string[]) => void;
  disabled?: boolean;
  groups?: FilterGroup[];
}

export function MultiSelectFilter({
  label,
  options,
  selected,
  onChange,
  disabled,
  groups,
}: MultiSelectFilterProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const count = selected.length;
  const groupId = useId();
  const filterRef = useRef<HTMLInputElement>(null);
  const showFilter = options.length > 6;

  useEffect(() => {
    if (open && showFilter) {
      requestAnimationFrame(() => filterRef.current?.focus());
    }
    if (!open) setFilter("");
  }, [open, showFilter]);

  const filteredOptions = useMemo(() => {
    const q = filter.toLowerCase().trim();
    if (!q) return options;
    return options.filter((o) => o.toLowerCase().includes(q));
  }, [options, filter]);

  const filteredGroups = useMemo(() => {
    if (!groups) return null;
    const q = filter.toLowerCase().trim();
    if (!q) return groups;
    return groups
      .map((g) => ({
        ...g,
        options: g.options.filter((o) => o.toLowerCase().includes(q)),
      }))
      .filter((g) => g.options.length > 0);
  }, [groups, filter]);

  function toggle(value: string) {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  }

  function renderOption(option: string) {
    const checked = selected.includes(option);
    const id = `${groupId}-${option}`;
    return (
      <div
        key={option}
        className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-[13px] hover:bg-[var(--color-row-hover)] has-[:focus-visible]:bg-[var(--color-row-hover)]"
        onClick={() => toggle(option)}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            toggle(option);
          }
        }}
      >
        <Checkbox
          id={id}
          checked={checked}
          onCheckedChange={() => toggle(option)}
        />
        <label htmlFor={id} className="font-mono text-foreground">
          {option}
        </label>
      </div>
    );
  }

  const hasResults = filteredGroups
    ? filteredGroups.length > 0
    : filteredOptions.length > 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || options.length === 0}
          className="h-9 cursor-pointer gap-1.5 font-mono text-[13px]"
        >
          <span
            className={count > 0 ? "text-foreground" : "text-muted-foreground"}
          >
            {count > 0 ? `${label}: ${count}` : label}
          </span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 overflow-hidden border-border bg-card p-0"
      >
        {showFilter && (
          <div className="border-b border-border px-3 py-1.5">
            <input
              ref={filterRef}
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter..."
              className="w-full bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none"
              aria-label={`Filter ${label} options`}
            />
          </div>
        )}
        <div aria-label={label} className="max-h-60 overflow-y-auto py-1">
          {filteredGroups
            ? filteredGroups.map((group) => (
                <div key={group.label}>
                  <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                    {group.label}
                  </div>
                  {group.options.map(renderOption)}
                </div>
              ))
            : filteredOptions.map(renderOption)}
          {!hasResults && (
            <div className="px-3 py-2 text-[13px] text-muted-foreground">
              No matches
            </div>
          )}
        </div>
        {count > 0 && (
          <div className="border-t border-border px-3 py-1.5">
            <button
              type="button"
              onClick={() => onChange([])}
              className="cursor-pointer text-xs text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
