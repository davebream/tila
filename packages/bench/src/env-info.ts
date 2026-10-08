import { execFileSync } from "node:child_process";
import os from "node:os";

export function gitInfo(cwd: string): {
  sha: string | null;
  dirty: boolean | null;
} {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { sha, dirty: status.trim().length > 0 };
  } catch {
    return { sha: null, dirty: null };
  }
}

export function hardwareInfo() {
  const cpus = os.cpus();
  return {
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpu_model: cpus[0]?.model ?? "unknown",
    cpu_count: cpus.length,
    total_mem_bytes: os.totalmem(),
    node_version: process.version,
  };
}

export function makeRunId(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .replace("T", "-");
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rand}`;
}
