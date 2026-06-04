import { cn } from "@/lib/utils";

type PresenceDotProps = {
  status: "active" | "idle" | "lost";
  pulse?: boolean;
  className?: string;
};

const statusColor = {
  active: "bg-status-green",
  idle: "bg-status-amber",
  lost: "bg-status-red",
} as const;

export function PresenceDot({
  status,
  pulse = status === "active",
  className,
}: PresenceDotProps) {
  return (
    <span
      className={cn(
        "relative inline-block size-2 rounded-full",
        statusColor[status],
        className,
      )}
      role="img"
      aria-label={status}
    >
      {pulse && (
        <span
          className={cn(
            "absolute inset-[-3px] rounded-full animate-[presence-pulse_1.6s_ease-out_infinite]",
            statusColor[status],
          )}
        />
      )}
    </span>
  );
}
