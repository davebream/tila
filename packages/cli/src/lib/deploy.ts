import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TilaProjectConfig } from "@tila/schemas";
import type { Cloudflare } from "./cloudflare-client";
import {
  isMonorepoLayout,
  resolveUiDistDir,
  resolveWorkerMainPath,
  tilaHome,
} from "./provisioning";
import {
  detectWrangler,
  parseDeployedUrl,
  runWrangler,
  validateTokenScopes,
} from "./wrangler-cli";
import { assertAssetLimits, generateWranglerConfig } from "./wrangler-config";

export interface DeployConfig {
  slug: string;
  accountId: string;
}

export function resolveDeployConfig(opts: {
  config: TilaProjectConfig | null;
}): DeployConfig {
  if (!opts.config) {
    throw new Error(
      "No tila project found.\n\n" +
        "Run 'tila project create' to create a project first.",
    );
  }

  const backend = opts.config.backend ?? "cloudflare";
  if (backend !== "cloudflare") {
    throw new Error(
      "Deploy requires a Cloudflare-backed project.\n\n" +
        "The current project uses the local backend.",
    );
  }

  if (!opts.config.cloudflare?.account_id) {
    throw new Error(
      "No Cloudflare account ID in config.\n\n" +
        "Run 'tila project create' to provision.",
    );
  }

  return {
    slug: opts.config.project_id,
    accountId: opts.config.cloudflare.account_id,
  };
}

export interface DeployOptions {
  cf: Cloudflare;
  accountId: string;
  scriptName: string;
  d1DatabaseId: string;
  r2BucketName: string;
  apiToken: string;
  skipUi: boolean;
}

/**
 * Simplified UI outcome. Under Option A the Worker and UI deploy as a single
 * `wrangler deploy` — hard failures throw rather than returning a degraded state.
 *
 * - "deployed": the full deploy (Worker + UI assets) succeeded; url is the deployed URL
 * - "skipped":  the deploy ran in Worker-only mode (--skip-ui flag was set)
 */
export type UiOutcome =
  | { kind: "deployed"; url: string }
  | { kind: "skipped"; reason: "flag" };

export interface DeployResult {
  workerUrl: string;
  ui: UiOutcome;
}

/** Last `n` non-empty lines of captured output — where build errors live. */
function tail(text: string, n: number): string {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  return lines.slice(-n).join("\n");
}

/** Best-effort: persist full build output to ~/.tila/logs/. Returns path or undefined. */
function writeBuildLog(output: string): string | undefined {
  try {
    const dir = join(tilaHome(), "logs");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logPath = join(dir, `ui-build-${stamp}.log`);
    writeFileSync(logPath, output);
    return logPath;
  } catch {
    return undefined;
  }
}

/**
 * Probe the deployed URL to confirm the deploy succeeded.
 *
 * Checks BOTH:
 * - GET /        (SPA index — expect <500; a 5xx here is the regression #404 is about)
 * - GET /api/health  (exercises run_worker_first routing to the Worker)
 *
 * Retries up to maxAttempts with exponential backoff to absorb cold start.
 * Throws if either returns ≥500 after all retries.
 * Throws if NO probe across BOTH paths ever received any HTTP response at all
 * (every attempt threw — connection refused, DNS failure, etc.).
 * Tolerates asymmetric flake: if at least one path received any HTTP response,
 * the other path all-throwing does NOT cause a failure.
 */
async function smokeCheck(url: string, maxAttempts = 3): Promise<void> {
  const baseUrl = url.replace(/\/$/, "");
  const paths = ["/", "/api/health"];

  // Track whether any probe across all paths ever received an HTTP response.
  let anyPathGotResponse = false;

  for (const path of paths) {
    let lastStatus = 0;
    let pathGotResponse = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          signal: AbortSignal.timeout(15_000),
          redirect: "follow",
        });
        lastStatus = res.status;
        pathGotResponse = true;
        anyPathGotResponse = true;

        if (lastStatus < 500) {
          // Non-5xx — pass
          break;
        }

        // 5xx — retry with backoff unless it's the last attempt
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, attempt * 1000));
        }
      } catch {
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, attempt * 1000));
        }
      }
    }

    if (pathGotResponse && lastStatus >= 500) {
      throw new Error(
        `Smoke check failed: ${baseUrl}${path} returned HTTP ${lastStatus} after ${maxAttempts} attempt(s). The deploy may have succeeded but the Worker is returning server errors. Investigate with: wrangler tail`,
      );
    }
    // If !pathGotResponse (all attempts threw for this path), continue to the
    // next path — asymmetric-flake tolerance: if the other path is reachable we
    // do not fail. The all-unreachable case is caught below after both paths run.
  }

  if (!anyPathGotResponse) {
    throw new Error(
      `Smoke check failed: wrangler reported success but the deployed URL was unreachable after ${maxAttempts} attempt(s) on all probed paths. The Worker may not be serving traffic yet. Investigate with: wrangler tail`,
    );
  }
}

export async function deployWorkerWithAssets(
  opts: DeployOptions,
): Promise<DeployResult> {
  // Step 1: Ensure wrangler is present and meets the version floor
  await detectWrangler();

  // Step 2: Validate CF token has required scopes before attempting deploy
  await validateTokenScopes(opts.apiToken, opts.accountId);

  const workerMainPath = resolveWorkerMainPath();
  const uiDistDir = resolveUiDistDir();

  if (opts.skipUi) {
    // Worker-only deploy: generate a config without the [assets] block
    // by calling wrangler with --no-bundle or using a minimal config.
    // We generate a standard config then run wrangler deploy with skipUi in the
    // config path name to distinguish (wrangler-config doesn't produce an assets
    // block when skipUi is requested).
    const configPath = generateWranglerConfig({
      slug: opts.scriptName,
      accountId: opts.accountId,
      databaseId: opts.d1DatabaseId,
      r2BucketName: opts.r2BucketName,
      skipAssets: true,
    });

    const { stdout } = await runWrangler(["deploy", "-c", configPath], {
      token: opts.apiToken,
      accountId: opts.accountId,
      cwd: dirname(configPath),
    });

    const deployedUrl =
      parseDeployedUrl(stdout) ?? `https://${opts.scriptName}.workers.dev`;

    return { workerUrl: deployedUrl, ui: { kind: "skipped", reason: "flag" } };
  }

  // Step 3: Build UI (monorepo-only; in sidecar mode the pre-built dist is used as-is)
  if (isMonorepoLayout()) {
    try {
      execSync("pnpm --filter @tila/ui build", {
        env: { ...process.env, VITE_API_URL: "" },
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const output =
        `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() ||
        (e.message ?? "unknown build error");
      const logPath = writeBuildLog(output);
      const tailLines = tail(output, 8);
      const logHint = logPath ? `\nFull log: ${logPath}` : "";
      throw new Error(
        `UI build failed:\n${tailLines}${logHint}\n\nRetry: pnpm --filter @tila/ui build`,
      );
    }
  }

  // Step 4: Assert asset limits before deploy
  assertAssetLimits(uiDistDir);

  // Step 5: Generate the per-deploy wrangler config
  const configPath = generateWranglerConfig({
    slug: opts.scriptName,
    accountId: opts.accountId,
    databaseId: opts.d1DatabaseId,
    r2BucketName: opts.r2BucketName,
  });

  // Step 6: Run wrangler deploy
  const { stdout } = await runWrangler(["deploy", "-c", configPath], {
    token: opts.apiToken,
    accountId: opts.accountId,
    cwd: dirname(configPath),
  });

  // Step 7: Parse deployed URL from wrangler output
  const deployedUrl =
    parseDeployedUrl(stdout) ?? `https://${opts.scriptName}.workers.dev`;

  // Step 8: Smoke check — hard gate; throws if either / or /api/health returns ≥500
  await smokeCheck(deployedUrl);

  return {
    workerUrl: deployedUrl,
    ui: { kind: "deployed", url: deployedUrl },
  };
}

/**
 * Render a UI outcome into the human-facing strings callers need: a spinner
 * stop message and the summary line for the "Deploy complete" note. Pure — no I/O.
 */
export function describeUiOutcome(ui: UiOutcome): {
  spinnerMessage: string;
  uiLine: string;
} {
  switch (ui.kind) {
    case "deployed":
      return {
        spinnerMessage: "Worker and UI deployed.",
        uiLine: `UI:      ${ui.url}`,
      };
    case "skipped":
      return {
        spinnerMessage: "Worker deployed (UI skipped).",
        uiLine: "UI:      not deployed",
      };
  }
}
