/**
 * Spawn helper for multi-process integration tests.
 *
 * Wraps Bun.spawn() to launch subprocess.ts with specific env vars,
 * wait for completion, and collect stdout/stderr/exitCode.
 */

import { join } from "node:path";

const SUBPROCESS_PATH = join(import.meta.dir, "subprocess.ts");

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn a Bun subprocess running subprocess.ts with the given operation
 * and environment variables.
 *
 * @param op - The TILA_OP value (e.g., "acquire", "journal-append", "acquire-hold")
 * @param env - Additional environment variables (TILA_DB_PATH, TILA_HOLDER, etc.)
 * @returns Promise resolving to { exitCode, stdout, stderr }
 */
export async function spawnWorker(
  op: string,
  env: Record<string, string>,
): Promise<SpawnResult> {
  const proc = Bun.spawn(["bun", "run", SUBPROCESS_PATH], {
    env: {
      ...process.env,
      TILA_OP: op,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;

  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

/**
 * Spawn a Bun subprocess and return the process handle (for signal control).
 * Used by crash-recovery tests that need to send SIGKILL.
 *
 * @returns The Bun subprocess handle with pid, stdout, stderr
 */
export function spawnWorkerProcess(
  op: string,
  env: Record<string, string>,
): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(["bun", "run", SUBPROCESS_PATH], {
    env: {
      ...process.env,
      TILA_OP: op,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}
