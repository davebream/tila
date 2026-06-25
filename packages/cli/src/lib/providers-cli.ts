/**
 * Concrete ProviderPorts for the CLI (C7 — Phase 6).
 *
 * This is the ONLY file in packages/cli that imports:
 *   - @clack/prompts  (for the Prompter)
 *   - node:child_process  (for the runCommand port)
 *
 * @tila/auth-store must NOT import either of these; it receives them only via
 * the injected ProviderPorts interface.
 */

import { execFile } from "node:child_process";
import * as p from "@clack/prompts";
import {
  type Clock,
  type EnvProbe,
  type Prompter,
  type ProviderPorts,
  type RunCommand,
  type RunCommandResult,
  processEnvProbe,
} from "@tila/auth-store";

// ---------------------------------------------------------------------------
// Real Clock
// ---------------------------------------------------------------------------

const realClock: Clock = {
  now(): number {
    return Date.now();
  },
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
};

// ---------------------------------------------------------------------------
// Clack-backed Prompter
// ---------------------------------------------------------------------------

/**
 * Display the device-flow user_code and verification_uri via @clack/prompts.
 * Non-blocking: renders the note and best-effort opens the browser.
 */
const clackPrompter: Prompter = {
  async displayDeviceCode(opts: {
    userCode: string;
    verificationUri: string;
    expiresIn: number;
  }): Promise<void> {
    p.note(
      `Open this URL in your browser to authorize tila:\n\n  ${opts.verificationUri}\n\nThen enter code: ${opts.userCode}`,
      "Device Authorization",
    );

    // Best-effort browser open — swallowed internally by openInBrowser
    try {
      const { openInBrowser } = await import("./browser.js");
      openInBrowser(opts.verificationUri);
    } catch {
      // Non-fatal: if browser open fails, the user can navigate manually
    }
  },
};

// ---------------------------------------------------------------------------
// execFile-backed runCommand port
// ---------------------------------------------------------------------------

/**
 * Execute a command via execFile (argv array, shell:false).
 *
 * Timeout + SIGTERM → SIGKILL-grace kill semantics are owned by this port,
 * not the provider. Default timeout: 30s.
 *
 * Returns RunCommandResult; never throws (errors are encoded in exitCode).
 * Throws only for genuine infrastructure failures (e.g., ENOENT for missing command).
 */
const nodeRunCommand: RunCommand = async (
  command: string,
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<RunCommandResult> => {
  const timeoutMs = opts?.timeoutMs ?? 30_000;

  return new Promise<RunCommandResult>((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        shell: false,
        timeout: timeoutMs,
        killSignal: "SIGTERM",
        maxBuffer: 1024 * 1024, // 1MB stdout/stderr cap
        encoding: "utf-8",
      },
      (error, stdout, stderr) => {
        if (error) {
          // execFile error: check if it was a timeout or a non-zero exit
          if (
            error.code === "ETIMEDOUT" ||
            error.signal === "SIGTERM" ||
            error.killed
          ) {
            // Best-effort SIGKILL after timeout
            try {
              child.kill("SIGKILL");
            } catch {
              // Ignore — process may have already exited
            }
            // Encode timeout as a special exitCode that ExecCredentialError will handle
            resolve({
              exitCode: -1,
              stdout: typeof stdout === "string" ? stdout : "",
              stderr: "timeout",
            });
            return;
          }

          // Non-zero exit code — the provider handles this as ExecCredentialError
          resolve({
            exitCode:
              typeof error.code === "number"
                ? error.code
                : (child.exitCode ?? 1),
            stdout: typeof stdout === "string" ? stdout : "",
            stderr: typeof stderr === "string" ? stderr : String(error),
          });
          return;
        }

        resolve({
          exitCode: child.exitCode ?? 0,
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
        });
      },
    );
  });
};

// ---------------------------------------------------------------------------
// Public: buildProviderPorts
// ---------------------------------------------------------------------------

/**
 * Build concrete ProviderPorts for the CLI.
 *
 * These are wired into every CredentialProvider via ProviderContext.ports.
 * Tests replace individual ports with fakes.
 */
export function buildProviderPorts(): ProviderPorts {
  return {
    fetch: globalThis.fetch,
    prompter: clackPrompter,
    // processEnvProbe is a constant EnvProbe (not a function) — spread to snapshot
    env: { isCI: processEnvProbe.isCI, isTTY: processEnvProbe.isTTY },
    clock: realClock,
    runCommand: nodeRunCommand,
  };
}

// ---------------------------------------------------------------------------
// Re-export fetchClientId for init.ts to use
// ---------------------------------------------------------------------------

export { fetchClientId } from "./github-oauth-device.js";
