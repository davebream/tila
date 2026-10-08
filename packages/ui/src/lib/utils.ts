import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function encodeArtifactKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export function parseArtifactKey(key: string): {
  entity: string;
  label: string;
} {
  const parts = key.split("/");
  if (parts[0] === "versioned") {
    return {
      entity: "",
      label: parts.length === 5 ? `${parts[2]} · revision ${parts[3]}` : key,
    };
  }
  const entity = parts.length >= 3 ? parts[1] : "";
  return { entity, label: entity || key };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
