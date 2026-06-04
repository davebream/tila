import { cn } from "@/lib/utils";

type TraceBarTone = "blue" | "green" | "amber" | "red" | "muted";

interface TraceBarProps {
  start: number;
  dur: number;
  total: number;
  tone?: TraceBarTone;
  count?: string;
  className?: string;
}

const toneColor: Record<TraceBarTone, string> = {
  blue: "var(--color-accent)",
  green: "var(--color-status-green)",
  amber: "var(--color-status-amber)",
  red: "var(--color-status-red)",
  muted: "var(--color-fg-faint)",
};

export function TraceBar({
  start,
  dur,
  total,
  tone = "blue",
  count,
  className,
}: TraceBarProps) {
  const left = (start / total) * 100;
  const width = Math.max(0.5, (dur / total) * 100);
  const color = toneColor[tone];

  return (
    <div className={cn("relative h-[18px]", className)}>
      <div
        style={{
          position: "absolute",
          left: `${left}%`,
          width: `${width}%`,
          top: 4,
          height: 10,
          background: color,
          borderRadius: 2,
          opacity: 0.85,
        }}
      />
      {count !== undefined && (
        <span
          className="absolute font-mono text-[10px] text-fg-faint whitespace-nowrap"
          style={{
            left: `calc(${left}% + ${width}%)`,
            marginLeft: 6,
            top: 1,
          }}
        >
          {count}
        </span>
      )}
    </div>
  );
}
