import { useEffect, useState } from "react";

export function LastRefreshed({
  dataUpdatedAt,
}: {
  dataUpdatedAt: number | undefined;
}) {
  const [, tick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => tick((t) => t + 1), 5_000);
    return () => clearInterval(id);
  }, []);

  if (!dataUpdatedAt) return null;

  const ago = Math.floor((Date.now() - dataUpdatedAt) / 1000);
  const label =
    ago < 5
      ? "just now"
      : ago < 60
        ? `${ago}s ago`
        : `${Math.floor(ago / 60)}m ago`;

  return (
    <span
      className="font-mono text-[10px] text-fg-faint"
      title="Last data refresh"
    >
      Updated {label}
    </span>
  );
}
