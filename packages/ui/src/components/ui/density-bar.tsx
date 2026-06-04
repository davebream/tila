import { cn } from "@/lib/utils";

type DensityBarTone = "blue" | "green" | "amber" | "red";

interface DensityBarProps {
  pct: number;
  w?: number;
  h?: number;
  tone?: DensityBarTone;
  className?: string;
  "aria-label"?: string;
}

const toneColor: Record<DensityBarTone, string> = {
  blue: "var(--color-accent)",
  green: "var(--color-status-green)",
  amber: "var(--color-status-amber)",
  red: "var(--color-status-red)",
};

export function DensityBar({
  pct,
  w = 90,
  h = 4,
  tone = "blue",
  className,
  "aria-label": ariaLabel = "Density",
}: DensityBarProps) {
  const clampedPct = Math.max(0, Math.min(100, pct));

  return (
    <span
      className={cn("inline-block align-middle rounded-[2px]", className)}
      style={{
        width: w,
        height: h,
        background: "var(--color-border-soft)",
        position: "relative",
      }}
      role="meter"
      aria-label={ariaLabel}
      aria-valuenow={clampedPct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span
        style={{
          position: "absolute",
          inset: 0,
          width: `${clampedPct}%`,
          background: toneColor[tone],
          borderRadius: 2,
        }}
      />
    </span>
  );
}
