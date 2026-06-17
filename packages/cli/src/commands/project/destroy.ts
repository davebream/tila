import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import type { TilaInfraConfig } from "@tila/schemas";
import { defineCommand } from "citty";
import { parse } from "smol-toml";
import { findConfig } from "../../config";
import { createCloudflareClient } from "../../lib/cloudflare-client";
import { loadInfraConfig } from "../../lib/infra-config";
import { resolveCfApiToken, tilaHome } from "../../lib/provisioning";
import {
  type DestroyPlan,
  resolveDestroyPlan,
  resolveInfraDestroyToken,
} from "../../lib/resolve-destroy-plan";
import {
  cleanD1NonTokenRecords,
  cleanLocalFiles,
  deleteD1TokenRecord,
  verifyStoresEmpty,
  wipeProjectViaInfraToken,
  wipeProjectViaWorker,
} from "../../lib/teardown";

/**
 * Read TILA_API_TOKEN from .tila/.env directly (raw read, no user-flow auth import).
 * Admin-plane command: reads the raw file, compliant with flow-separation rule #1.
 */
function readTilaApiToken(tilaDir: string): string | null {
  // 1. Environment variable takes priority
  const envToken = process.env.TILA_API_TOKEN;
  if (envToken && envToken.trim().length > 0) {
    return envToken.trim();
  }

  // 2. Fall back to .tila/.env file
  const envFilePath = join(tilaDir, ".env");
  if (!existsSync(envFilePath)) {
    return null;
  }

  const content = readFileSync(envFilePath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.length === 0) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    const unquoted = value.replace(/^["']|["']$/g, "");
    if (key === "TILA_API_TOKEN") {
      return unquoted;
    }
  }

  return null;
}

/**
 * Infra-owner destroy: wipe a project by slug with no local .tila/ config.
 * Remote state (DO + R2) is wiped through the Worker's /_internal destroy
 * endpoint using INFRA_DESTROY_TOKEN; D1 records are cleaned via the CF SDK.
 * Trust the endpoint's internal doWiped read-back instead of the per-project
 * store-counts verify (which needs a per-project token we do not hold here).
 */
async function runInfraDestroy(
  args: { force?: boolean; json?: boolean },
  plan: Extract<DestroyPlan, { mode: "infra" }>,
  infraConfig: TilaInfraConfig | null,
): Promise<void> {
  const { slug, workerUrl, accountId, databaseId } = plan;

  const infraToken = resolveInfraDestroyToken(
    infraConfig,
    process.env.INFRA_DESTROY_TOKEN,
  );
  if (!infraToken) {
    p.cancel(
      "No INFRA_DESTROY_TOKEN available.\n\nSet it in the environment or add infra_destroy_token to ~/.tila/infra.toml.\nThis secret authorizes destroying a project you have no local config for.",
    );
    process.exit(1);
  }

  const cfApiToken = resolveCfApiToken();
  if (!cfApiToken) {
    p.cancel(
      "CLOUDFLARE_API_TOKEN not found. Set it in ~/.tila/.env or export it.",
    );
    process.exit(1);
  }
  const cf = createCloudflareClient(cfApiToken);

  p.note(
    ["Remote project state (DO + R2)", "Project records (D1)"].join("\n"),
    `Destroy project ${slug} (infra mode)`,
  );

  if (!args.force) {
    const answer = await p.text({
      message: `Type "${slug}" to confirm:`,
      validate: (value) => {
        if (value !== slug) return `Expected "${slug}"`;
      },
    });
    if (p.isCancel(answer) || answer !== slug) {
      p.cancel("Destroy cancelled.");
      process.exit(1);
    }
  }

  const failures: Array<{ label: string; message: string }> = [];
  const s = p.spinner();

  // Step 1: Wipe remote state (DO + R2) via the infra endpoint.
  s.start("Wiping remote project state...");
  const wipe = await wipeProjectViaInfraToken(workerUrl, infraToken, slug);
  s.stop(
    wipe.ok
      ? "Remote project state wiped."
      : `Remote project state: ${wipe.errorMessage}`,
  );
  if (!wipe.ok) {
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, slug, mode: "infra", failures: [wipe.errorMessage] })}\n`,
      );
    } else {
      p.log.error(wipe.errorMessage);
    }
    process.exit(1);
  }

  // Step 2: Clean D1 non-token records (CF SDK).
  s.start("Cleaning project records...");
  const d1 = await cleanD1NonTokenRecords(cf, accountId, databaseId, slug);
  s.stop(d1.ok ? "Project records cleaned." : `Project records: ${d1.message}`);
  if (!d1.ok) failures.push({ label: "Project records", message: d1.message });

  // Step 3: Delete the _tokens row LAST.
  const tok = await deleteD1TokenRecord(cf, accountId, databaseId, slug);
  if (!tok.ok) failures.push({ label: "Project tokens", message: tok.message });

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: failures.length === 0,
        slug,
        mode: "infra",
        doWiped: wipe.doWiped,
        failures: failures.map((f) => f.message),
      })}\n`,
    );
  } else if (failures.length > 0) {
    p.log.error(`${failures.length} resource(s) failed. Clean up manually.`);
    for (const f of failures) p.log.error(`  ${f.label}: ${f.message}`);
  } else {
    p.log.success(`Project ${slug} destroyed.`);
  }

  if (failures.length > 0) process.exit(1);
}

export default defineCommand({
  meta: {
    name: "destroy",
    description: "Destroy a tila project and its resources",
  },
  args: {
    slug: {
      type: "positional",
      description:
        "Project slug to destroy by ID (infra-owner mode; no local .tila/ needed)",
      required: false,
    },
    force: {
      type: "boolean",
      description: "Skip confirmation prompt",
      default: false,
    },
    "keep-local": {
      type: "boolean",
      description: "Keep .tila/ directory",
      default: false,
    },
    json: {
      type: "boolean",
      description: "Emit structured JSON result",
      default: false,
    },
  },
  async run({ args }) {
    const cwd = process.cwd();
    const tilaDir = join(cwd, ".tila");

    // Step 1: Resolve the destroy plan — local (.tila/ in cwd) vs infra-owner
    // (target a slug using ~/.tila/infra.toml + INFRA_DESTROY_TOKEN).
    const slugArg =
      typeof args.slug === "string" && args.slug.length > 0
        ? args.slug
        : undefined;
    const localConfig = findConfig(cwd);
    let infraConfig: TilaInfraConfig | null = null;
    try {
      infraConfig = loadInfraConfig(tilaHome());
    } catch {
      infraConfig = null;
    }

    const plan = resolveDestroyPlan({ slugArg, localConfig, infraConfig });

    if (plan.mode === "error") {
      p.cancel(plan.message);
      process.exit(1);
    }

    if (plan.mode === "needs-picker") {
      p.cancel(
        "No project found in this directory.\n\nTo destroy a project you are not set up for locally, target it by ID:\n    tila project destroy <slug>\n\nList every project on this account with:\n    tila project list",
      );
      process.exit(1);
    }

    if (plan.mode === "infra") {
      await runInfraDestroy(args, plan, infraConfig);
      return;
    }

    // plan.mode === "local" — the per-project path, using the cwd config.
    const config = plan.config;

    const slug = config.project_id;
    const workerUrl = config.worker_url ?? null;
    const accountId = config.cloudflare?.account_id;
    const isLocalMode =
      config.backend === "local" || (!accountId && !workerUrl);

    // Step 2: Determine credential requirements
    // Dual-credential model:
    //   - CLOUDFLARE_API_TOKEN (CF API) → used for D1 cleanup via CF SDK (admin-plane)
    //   - TILA_API_TOKEN (from .tila/.env) → used for Worker admin destroy endpoint
    //
    // For deployed projects: both are required.
    // For genuine local-mode: neither worker step runs, but CF cleanup may still run if configured.

    // Resolve TILA_API_TOKEN (for Worker destroy call)
    const tilaApiToken = readTilaApiToken(tilaDir);

    // Deployed project checks: must have worker_url + tilaApiToken
    if (!isLocalMode && accountId && workerUrl && !tilaApiToken) {
      p.cancel(
        "TILA_API_TOKEN not found in .tila/.env.\n\nThis token is required to wipe the remote project state.\nCheck that .tila/.env contains TILA_API_TOKEN=<your-token>.",
      );
      process.exit(1);
    }

    // If config indicates Cloudflare-mode but worker_url is missing → FAILURE (not silent skip)
    // (Finding 3.2: silently skipping leaves a DO+R2 orphan)
    if (!isLocalMode && accountId && !workerUrl) {
      p.cancel(
        "Project config is in Cloudflare mode but worker_url is missing.\n\nCannot safely destroy without wiping remote state.\nCheck .tila/config.toml or re-run provisioning.",
      );
      process.exit(1);
    }

    // Step 3: Resolve D1 database ID (admin-plane CF API path — allowed per flow-separation)
    let databaseId: string | null = null;

    if (accountId) {
      // Try infra.toml first
      try {
        const homeDir = tilaHome();
        const infraConfig = loadInfraConfig(homeDir);
        databaseId = infraConfig.d1_database_id;
      } catch {
        // fall through to wrangler.toml fallback
      }

      // Fallback: parse .tila/wrangler.toml
      if (!databaseId) {
        const wranglerPath = join(tilaDir, "wrangler.toml");
        if (existsSync(wranglerPath)) {
          try {
            const raw = readFileSync(wranglerPath, "utf-8");
            const parsed = parse(raw);
            const d1Databases = parsed.d1_databases;
            if (Array.isArray(d1Databases) && d1Databases.length > 0) {
              const firstDb = d1Databases[0] as Record<string, unknown>;
              if (typeof firstDb.database_id === "string") {
                databaseId = firstDb.database_id;
              }
            }
          } catch {
            // ignore parse errors
          }
        }
      }

      if (!databaseId) {
        p.log.warn(
          "Could not resolve D1 database ID from ~/.tila/infra.toml or .tila/wrangler.toml. D1 cleanup will be skipped.",
        );
      }
    }

    // Step 4: Resolve CF API token (for D1 SDK operations — admin-plane)
    const cfApiToken = resolveCfApiToken();
    if (accountId && !cfApiToken) {
      p.cancel(
        "CLOUDFLARE_API_TOKEN not found. Set it in ~/.tila/.env or export it.",
      );
      process.exit(1);
    }

    const cf =
      accountId && cfApiToken ? createCloudflareClient(cfApiToken) : null;

    // Step 5: Confirmation
    const resources: string[] = [];
    if (workerUrl && !isLocalMode) resources.push("Remote project state");
    if (databaseId) resources.push("Project records (D1)");
    if (!args["keep-local"]) resources.push("Local:      .tila/");
    p.note(resources.join("\n"), `Destroy project ${slug}`);

    if (!args.force) {
      const answer = await p.text({
        message: `Type "${slug}" to confirm:`,
        validate: (value) => {
          if (value !== slug) return `Expected "${slug}"`;
        },
      });
      if (p.isCancel(answer)) {
        p.cancel("Destroy cancelled.");
        process.exit(1);
      }
      if (answer !== slug) {
        p.log.error(
          `Confirmation failed. Expected "${slug}", got "${answer}".`,
        );
        process.exit(1);
      }
    }

    // Tracking for --json output
    const storeResults: {
      do: "ok" | "skipped" | "failed";
      r2: "ok" | "skipped" | "failed" | "gc-skipped";
      d1: "ok" | "skipped" | "failed";
      local: "ok" | "skipped" | "failed";
    } = {
      do: "skipped",
      r2: "skipped",
      d1: "skipped",
      local: "skipped",
    };

    const failures: Array<{ label: string; message: string }> = [];
    const notes: string[] = [];
    const s = p.spinner();

    // Step 6: Wipe remote project state (Worker destroy endpoint)
    // Must run BEFORE D1 cleanup so the token can still authenticate.
    let workerWipeResult: Awaited<
      ReturnType<typeof wipeProjectViaWorker>
    > | null = null;

    if (isLocalMode || (!accountId && !workerUrl)) {
      // Genuine local-mode: skip DO/R2 wipe with a warning
      p.log.warn("Local-mode project: skipping remote state wipe.");
      storeResults.do = "skipped";
      storeResults.r2 = "skipped";
    } else if (workerUrl && tilaApiToken) {
      s.start("Wiping remote project state...");
      workerWipeResult = await wipeProjectViaWorker(
        workerUrl,
        tilaApiToken,
        slug,
      );
      s.stop(
        workerWipeResult.ok
          ? "Remote project state wiped."
          : `Remote project state: ${workerWipeResult.ok === false ? workerWipeResult.errorMessage : "failed"}`,
      );

      if (workerWipeResult.ok) {
        storeResults.do = workerWipeResult.doWiped ? "ok" : "ok"; // already empty counts as ok
        storeResults.r2 = workerWipeResult.r2GcSkipped ? "gc-skipped" : "ok";

        // Surface r2GcSkipped as a note (some shared artifact blobs remain — no background reaper)
        if (workerWipeResult.r2GcSkipped) {
          notes.push(
            "Some artifact blobs were not removed (over subrequest budget). No background cleanup will reclaim them.",
          );
          p.log.warn(
            "Some artifact blobs were not removed — re-run when project has fewer artifacts.",
          );
        }

        // Surface r2Failed
        if (workerWipeResult.r2Failed > 0) {
          storeResults.r2 = "failed";
          failures.push({
            label: "Artifact storage",
            message: `${workerWipeResult.r2Failed} artifact blob(s) could not be deleted`,
          });
        }
      } else {
        storeResults.do = "failed";
        storeResults.r2 = "failed";
        failures.push({
          label: "Remote project state",
          message: workerWipeResult.errorMessage,
        });
        // Do not remove .tila/ on worker failure (allow retry)
        if (args.json) {
          process.stdout.write(
            `${JSON.stringify({
              ok: false,
              stores: storeResults,
              failures: failures.map((f) => f.message),
            })}\n`,
          );
        } else {
          p.log.error(
            `${failures.length} resource(s) failed. Clean up manually.`,
          );
        }
        process.exit(1);
      }
    }

    // Step 7: Clean D1 non-token tables (5 tables, excluding _tokens)
    // _tokens is deleted LAST (after verification) per design.
    if (cf && accountId && databaseId) {
      s.start("Cleaning project records...");
      const d1NonTokenResult = await cleanD1NonTokenRecords(
        cf,
        accountId,
        databaseId,
        slug,
      );
      s.stop(
        d1NonTokenResult.ok
          ? "Project records cleaned."
          : `Project records: ${d1NonTokenResult.message}`,
      );
      if (!d1NonTokenResult.ok) {
        failures.push({
          label: "Project records",
          message: d1NonTokenResult.message,
        });
        storeResults.d1 = "failed";
      }
    }

    // Step 8: Verify stores empty (DO store-counts + D1 counts)
    let verifyPassed = true;
    if (workerUrl && tilaApiToken && cf && accountId && databaseId) {
      s.start("Verifying stores empty...");
      const verifyResult = await verifyStoresEmpty({
        cf,
        accountId,
        databaseId,
        slug,
        workerUrl,
        token: tilaApiToken,
      });
      s.stop(
        verifyResult.ok
          ? "All stores verified empty."
          : `Verification failed: ${verifyResult.failures[0] ?? "unknown"}`,
      );

      if (!verifyResult.ok) {
        verifyPassed = false;
        storeResults.d1 = "failed";
        storeResults.do = "failed";
        for (const failure of verifyResult.failures) {
          failures.push({ label: "Verification", message: failure });
        }
      }
    }

    // Step 9: Delete _tokens LAST (only after stores verify clean)
    if (verifyPassed && cf && accountId && databaseId) {
      const tokenResult = await deleteD1TokenRecord(
        cf,
        accountId,
        databaseId,
        slug,
      );
      if (!tokenResult.ok) {
        failures.push({
          label: "Project tokens",
          message: tokenResult.message,
        });
        storeResults.d1 = "failed";
      } else {
        if (storeResults.d1 !== "failed") storeResults.d1 = "ok";
      }
    } else if (!verifyPassed) {
      // Do NOT remove .tila/ when verification fails — allow retry
      if (args.json) {
        process.stdout.write(
          `${JSON.stringify({
            ok: false,
            stores: storeResults,
            failures: failures.map((f) => f.message),
          })}\n`,
        );
      } else {
        p.log.error(
          `${failures.length} check(s) failed. .tila/ kept for retry.`,
        );
        for (const f of failures) {
          p.log.error(`  ${f.label}: ${f.message}`);
        }
      }
      process.exit(1);
    }

    // Step 10: Remove local .tila/ directory (last step, unless --keep-local)
    if (!args["keep-local"]) {
      const localResult = cleanLocalFiles(tilaDir);
      storeResults.local = localResult.ok ? "ok" : "failed";
      if (!localResult.ok) {
        failures.push({ label: "Local files", message: localResult.message });
      }
    } else {
      storeResults.local = "skipped";
    }

    // Final output
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: failures.length === 0,
          stores: storeResults,
          failures: failures.map((f) => f.message),
        })}\n`,
      );
    } else {
      if (failures.length > 0) {
        p.log.error(
          `${failures.length} resource(s) failed. Clean up manually.`,
        );
      }
      if (notes.length > 0) {
        for (const note of notes) p.log.warn(note);
      }
      if (failures.length === 0) {
        p.log.success("Project destroyed. To re-create: tila project create");
      }
    }

    if (failures.length > 0) process.exit(1);
  },
});
