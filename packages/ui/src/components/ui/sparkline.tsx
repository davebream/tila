import { cn } from "@/lib/utils";

type SparklineTone = "blue" | "green" | "amber" | "red" | "muted";

interface SparklineProps {
  data: number[];
  w?: number;
  h?: number;
  tone?: SparklineTone;
  strokeWidth?: number;
  className?: string;
}

const toneColor: Record<SparklineTone, string> = {
  blue: "var(--color-accent)",
  green: "var(--color-status-green)",
  amber: "var(--color-status-amber)",
  red: "var(--color-status-red)",
  muted: "var(--color-fg-faint)",
};

export function Sparkline({
  data,
  w = 80,
  h = 14,
  tone = "blue",
  strokeWidth = 1.25,
  className,
}: SparklineProps) {
  if (!data || data.length < 2) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = (w - 2) / (data.length - 1);

  const points = data.map((v, i) => {
    const x = 1 + i * stepX;
    const y = h - 1 - ((v - min) / range) * (h - 2);
    return [x, y] as const;
  });

  const d = points
    .map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`))
    .join(" ");
  const last = points[points.length - 1];
  const color = toneColor[tone];

  return (
    <svg
      width={w}
      height={h}
      className={cn("inline-block align-middle", className)}
      aria-hidden="true"
    >
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.85"
      />
      <circle cx={last[0]} cy={last[1]} r="1.6" fill={color} />
    </svg>
  );
}
