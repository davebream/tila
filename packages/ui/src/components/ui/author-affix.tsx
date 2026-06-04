import { cn } from "@/lib/utils";

type AuthorAffixProps = {
  source: "agent" | "cli" | "user" | "sys";
  className?: string;
};

const sourceStyles = {
  agent: "text-signal-300 bg-tint-blue-12",
  cli: "text-status-amber bg-tint-amber",
  user: "text-status-green bg-tint-green",
  sys: "text-muted-foreground bg-tint-gray",
} as const;

export function AuthorAffix({ source, className }: AuthorAffixProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center font-mono text-[11px] lowercase px-[5px] py-px rounded-[3px] whitespace-nowrap",
        sourceStyles[source],
        className,
      )}
    >
      {source}
    </span>
  );
}
