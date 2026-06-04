export function formatDateTime(epochMs: number): string {
  const d = new Date(epochMs);
  const month = d.toLocaleString("default", { month: "short" });
  const day = d.getDate();
  const time = d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${month} ${day}, ${time}`;
}

export function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function relativeTime(epochMs: number): string {
  const diff = Math.floor((Date.now() - epochMs) / 1000);
  if (diff < 0) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return formatDateTime(epochMs);
}
