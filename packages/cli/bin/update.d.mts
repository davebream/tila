import type { CliUpdateResult } from "@tila/schemas";

export function performUpdate(options: {
  current: string;
  target: string | undefined;
  launcherRoot?: string;
  check?: boolean;
  progress?: (message: string) => void;
}): Promise<{ result?: CliUpdateResult; handoff?: unknown }>;
export function resultText(result: CliUpdateResult): string;
