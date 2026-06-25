import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import {
  InstanceKeyMismatchError,
  KeychainUnavailableError,
} from "@tila/auth-store";
import {
  DoctorProbeResponseSchema,
  DoctorSchemaResponseSchema,
  GitHubAppInfoResponseSchema,
  HealthResponseSchema,
  ReconcileReportSchema,
  SearchDriftReportSchema,
  SearchRebuildReportSchema,
  type WhoamiResponse,
  WhoamiResponseSchema,
} from "@tila/schemas";
import c from "ansis";
import { defineCommand } from "citty";
import { type CommandContext, runStartupChecks } from "../context";
import {
  buildAuthStore,
  resolveInstanceContext,
  toInstanceMetadata,
} from "../lib/instance-context";
import { jsonArg, printJson } from "../lib/output";
import { tilaHome } from "../lib/provisioning";

interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

const JOURNAL_WARN_THRESHOLD = 10_000;

const REQUIRED_SCHEMA_COLUMNS: Record<string, string[]> = {
  claims: [
    "resource",
    "holder",
    "machine",
    "user",
    "mode",
    "fence",
    "acquired_at",
    "expires_at",
    "metadata",
  ],
  journal: [
    "seq",
    "t",
    "kind",
    "resource",
    "actor",
    "fence",
    "data",
    "token_id",
  ],
  _schema_history: [
    "version",
    "definition",
    "applied_at",
    "applied_by",
    "change_summary",
    "strategy",
  ],
};

function findMissingSchemaColumns(
  columns: Record<string, Array<{ name: string }> | undefined>,
): string[] {
  const missing: string[] = [];
  for (const [table, required] of Object.entries(REQUIRED_SCHEMA_COLUMNS)) {
    const actual = new Set((columns[table] ?? []).map((col) => col.name));
    for (const column of required) {
      if (!actual.has(column)) {
        missing.push(`${table}.${column}`);
      }
    }
  }
  return missing;
}

function formatRelativeExpiry(expiresAt: number): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const deltaSeconds = expiresAt - nowSeconds;

  if (deltaSeconds < 0) {
    const absMinutes = Math.floor(Math.abs(deltaSeconds) / 60);
    const absHours = Math.floor(absMinutes / 60);
    const remainingMinutes = absMinutes % 60;

    if (absHours > 0) {
      return `expired ${absHours}h ${remainingMinutes}m ago`;
    }
    return `expired ${absMinutes}m ago`;
  }

  const minutes = Math.floor(deltaSeconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours > 0) {
    return `in ${hours}h ${remainingMinutes}m`;
  }
  return `in ${minutes}m`;
}

export default defineCommand({
  meta: { name: "doctor", description: "Check project health" },
  args: {
    "skip-auth": {
      type: "boolean",
      description: "Skip Cloudflare auth and account-match checks",
      default: false,
    },
    reconcile: {
      type: "boolean",
      description: "Walk R2 blobs and detect orphaned artifact pointers",
      default: false,
    },
    apply: {
      type: "boolean",
      description:
        "Materialize pointer recovery (implies --reconcile, default: dry-run)",
      default: false,
    },
    "search-drift": {
      type: "boolean",
      description:
        "Check search index consistency (missing, orphaned, stale docs)",
      default: false,
    },
    "search-rebuild": {
      type: "boolean",
      description:
        "Rebuild missing or stale search docs from artifact pointers (dry-run by default, use --apply to write)",
      default: false,
    },
    ...jsonArg,
  },
  async run({ args }) {
    const jsonMode = args.json as boolean;
    const checks: CheckResult[] = [];

    function addCheck(
      name: string,
      status: CheckResult["status"],
      detail: string,
    ) {
      checks.push({ name, status, detail });
    }

    const s = jsonMode ? null : p.spinner();

    // -----------------------------------------------------------------------
    // Auth-store diagnostic block (repo-independent, runs before startup checks)
    // -----------------------------------------------------------------------
    const tilahomePath = tilaHome();
    if (!existsSync(tilahomePath)) {
      // ~/.tila not found — skip all sub-checks with a single informational pass row
      addCheck(
        "auth-store",
        "pass",
        "~/.tila not found — no auth store configured (run `tila link <url>` to register an instance)",
      );
    } else {
      const authStore = buildAuthStore();

      // 1. store-backend: probe keychain accessibility
      try {
        await authStore.probe();
        addCheck(
          "auth-store/store-backend",
          "pass",
          "Keychain backend accessible",
        );
      } catch (err) {
        if (err instanceof KeychainUnavailableError) {
          addCheck(
            "auth-store/store-backend",
            "warn",
            `Keychain unavailable (step: ${err.step}) — credential operations will degrade to env-var fallback`,
          );
        } else {
          addCheck(
            "auth-store/store-backend",
            "fail",
            `Store backend error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // 2. resolve-trace: run instance resolution, render matched rung via toInstanceMetadata
      // SECURITY: NEVER serialize outcome.instance.credential — use toInstanceMetadata() only
      const outcome = await resolveInstanceContext({ authStore });
      if (outcome.ok) {
        const matchedStep = outcome.trace.find((step) => step.matched);
        const meta = toInstanceMetadata(outcome.instance);
        addCheck(
          "auth-store/resolve-trace",
          "pass",
          `Resolved via ${matchedStep?.rung ?? "unknown"}: instance=${meta.instance_key ?? "(inline)"} url=${meta.worker_url} trust=${meta.trust.kind}`,
        );
      } else {
        const traceLines = outcome.trace
          .filter((step) => step.attempted)
          .map((step) => `  [${step.rung}] ${step.detail}`)
          .join("\n");
        addCheck(
          "auth-store/resolve-trace",
          "warn",
          `Resolution failed: ${outcome.error.message}${traceLines ? `\n${traceLines}` : ""}`,
        );
      }

      // 3 + 4. orphaned-creds and stale-alias: shared registry + context read
      try {
        const instances = await authStore.listInstances();
        const currentContext = await authStore.getCurrentContext();

        // 3. orphaned-creds: trusted instance with no credential or key mismatch
        const orphaned: string[] = [];
        for (const inst of instances) {
          if (inst.trust.trusted) {
            try {
              const cred = await authStore.getCredential(inst.instance_key, {
                allowExpired: true,
              });
              if (!cred) {
                orphaned.push(
                  `${inst.instance_key}: trusted but no credential found`,
                );
              }
            } catch (credErr) {
              if (credErr instanceof InstanceKeyMismatchError) {
                orphaned.push(
                  `${inst.instance_key}: key mismatch (expected=${credErr.expected} actual=${credErr.actual})`,
                );
              } else if (!(credErr instanceof KeychainUnavailableError)) {
                // KeychainUnavailableError already reported in store-backend — skip
                orphaned.push(
                  `${inst.instance_key}: credential error (${credErr instanceof Error ? credErr.message : String(credErr)})`,
                );
              }
            }
          }
        }
        if (orphaned.length > 0) {
          addCheck(
            "auth-store/orphaned-creds",
            "warn",
            `Orphaned trusted instances:\n${orphaned.map((o) => `  ${o}`).join("\n")}`,
          );
        } else {
          addCheck(
            "auth-store/orphaned-creds",
            "pass",
            "No orphaned credentials",
          );
        }

        // 4. stale-alias: current_context not in registry → dangling pin
        if (currentContext !== null) {
          const found = instances.some(
            (i) => i.instance_key === currentContext,
          );
          if (!found) {
            addCheck(
              "auth-store/stale-alias",
              "fail",
              `Dangling pin: current_context '${currentContext}' not found in registry. Run 'tila switch <key>' or 'tila instances forget ${currentContext}'.`,
            );
          } else {
            addCheck(
              "auth-store/stale-alias",
              "pass",
              `Current context '${currentContext}' is registered`,
            );
          }
        } else {
          addCheck(
            "auth-store/stale-alias",
            "pass",
            "No current context pinned",
          );
        }
      } catch (err) {
        addCheck(
          "auth-store/orphaned-creds",
          "fail",
          `Registry check failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        addCheck(
          "auth-store/stale-alias",
          "fail",
          "Skipped (registry check failed)",
        );
      }

      // 5. ambiguous-inference: >1 conflicting matched rungs in trace
      {
        const matchedRungs = outcome.trace.filter((step) => step.matched);
        if (matchedRungs.length > 1) {
          const winnerRung = matchedRungs[0].rung;
          const allRungs = matchedRungs.map((step) => step.rung).join(", ");
          addCheck(
            "auth-store/ambiguous-inference",
            "warn",
            `Ambiguous resolution: multiple rungs matched (${allRungs}); winning rung: ${winnerRung}`,
          );
        } else {
          addCheck(
            "auth-store/ambiguous-inference",
            "pass",
            matchedRungs.length === 1
              ? `Unambiguous resolution via ${matchedRungs[0].rung}`
              : "No signals matched (resolution failed)",
          );
        }
      }
    }

    // -----------------------------------------------------------------------
    // Helper: render accumulated checks to output (used by early-exit branches)
    // -----------------------------------------------------------------------
    function renderAuthChecks(): void {
      if (checks.length === 0) return;
      const lines = checks.map((check) => {
        if (check.status === "pass") return `${c.green("✓")} ${check.detail}`;
        if (check.status === "warn")
          return `${c.yellow("!")} ${c.yellow(check.detail)}`;
        return `${c.red("✗")} ${c.red(check.detail)}`;
      });
      p.note(lines.join("\n"), "Auth-store checks");
    }

    // Run the 5-step startup check sequence
    let ctx: CommandContext;
    try {
      s?.start("Running startup checks...");
      ctx = await runStartupChecks({ skipAuth: args["skip-auth"] as boolean });
      s?.stop("Startup checks passed.");
    } catch (err) {
      s?.stop("Startup checks failed.");
      const msg = err instanceof Error ? err.message : String(err);
      // Include accumulated auth-store checks — never silently drop them
      const startupCheck: CheckResult = {
        name: "startup",
        status: "fail",
        detail: msg,
      };
      const allChecks = [...checks, startupCheck];
      const passed = allChecks.filter((ck) => ck.status === "pass").length;
      const warned = allChecks.filter((ck) => ck.status === "warn").length;
      const failed = allChecks.filter((ck) => ck.status === "fail").length;
      if (jsonMode) {
        console.log(
          JSON.stringify({
            checks: allChecks,
            summary: { passed, warned, failed },
          }),
        );
      } else {
        renderAuthChecks();
        p.cancel(msg);
      }
      process.exit(2);
      return;
    }

    if (ctx.config.backend === "local") {
      // Include already-accumulated auth-store checks in output (never drop them)
      const localCheck: CheckResult = {
        name: "backend",
        status: "fail",
        detail: "Local mode — remote checks require tila init",
      };
      const allChecks = [...checks, localCheck];
      const passed = allChecks.filter((ck) => ck.status === "pass").length;
      const warned = allChecks.filter((ck) => ck.status === "warn").length;
      const failed = allChecks.filter((ck) => ck.status === "fail").length;
      // Guard p.cancel with !jsonMode so doctor --json local emits only JSON (C2)
      if (jsonMode) {
        printJson({ checks: allChecks, summary: { passed, warned, failed } });
      } else {
        renderAuthChecks();
        p.cancel("This command requires a remote connection (tila init).");
      }
      process.exit(1);
      return;
    }

    addCheck("project", "pass", `Project: ${ctx.config.project_id}`);
    addCheck("worker-url", "pass", `Worker: ${ctx.config.worker_url}`);
    addCheck("api-token", "pass", "API token present");
    if (!args["skip-auth"]) {
      addCheck("wrangler", "pass", "Wrangler installed and logged in");
      addCheck("cf-account", "pass", "Cloudflare account match");
    }

    const client = ctx.client;
    if (!client) {
      addCheck(
        "worker-reachable",
        "warn",
        "Local mode — remote checks skipped",
      );
      return;
    }

    s?.start("Running remote checks...");

    // Check 1: Worker reachable
    try {
      const health = await client.get("/api/health", {
        schema: HealthResponseSchema,
        validate: true,
      });
      addCheck(
        "worker-reachable",
        "pass",
        `Worker reachable (version: ${health.version})`,
      );
    } catch (err) {
      addCheck(
        "worker-reachable",
        "fail",
        `Worker not reachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Check 2: D1 reachable (via auth/whoami)
    let whoamiResult: WhoamiResponse | null = null;
    try {
      const whoami = await client.get("/api/whoami", {
        schema: WhoamiResponseSchema,
        validate: true,
      });
      whoamiResult = whoami;
      addCheck(
        "d1-reachable",
        "pass",
        `D1 reachable, authenticated as: ${whoami.token_name} (project: ${whoami.project_id})`,
      );
    } catch (err) {
      addCheck(
        "d1-reachable",
        "fail",
        `Auth/D1 check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Check 2b: GitHub auth status (conditional on config auth.mode)
    const authMode = ctx.config?.auth?.mode ?? "tila-token";

    if (authMode !== "github-repo") {
      addCheck(
        "github-auth",
        "pass",
        `Auth mode: ${authMode} (GitHub auth N/A)`,
      );
    } else if (!whoamiResult) {
      addCheck("github-auth", "fail", "Skipped (whoami failed)");
    } else if (!whoamiResult.auth_kind) {
      addCheck(
        "github-auth",
        "warn",
        "Auth mode: github-repo (Worker may need update — auth_kind missing from whoami)",
      );
    } else if (
      whoamiResult.auth_kind === "session" &&
      whoamiResult.github_login
    ) {
      const nearExpiryThreshold = 600; // 10 minutes in seconds
      const nowSeconds = Math.floor(Date.now() / 1000);
      const expiresAt = whoamiResult.expires_at ?? 0;
      const isNearExpiry = expiresAt - nowSeconds <= nearExpiryThreshold;

      const status = isNearExpiry ? "warn" : "pass";
      const expiryStr = whoamiResult.expires_at
        ? formatRelativeExpiry(whoamiResult.expires_at)
        : "unknown";
      const permissionStr = whoamiResult.permission
        ? `, permission: ${whoamiResult.permission}`
        : "";

      addCheck(
        "github-auth",
        status,
        `GitHub auth: ${whoamiResult.github_login}${permissionStr}, expires ${expiryStr}`,
      );
    } else if (whoamiResult.auth_kind === "d1-token") {
      addCheck(
        "github-auth",
        "warn",
        "Config is github-repo but authenticated with D1 token",
      );
    } else {
      addCheck(
        "github-auth",
        "pass",
        `Auth kind: ${whoamiResult.auth_kind} (GitHub session N/A)`,
      );
    }

    // Checks 3-6: DO reachable, R2 reachable, expired claims, journal size
    try {
      const probePath = `/projects/${ctx.config.project_id}/doctor/probe`;
      const probe = await client.get(probePath, {
        schema: DoctorProbeResponseSchema,
        validate: true,
      });

      // Check 3: DO reachable + RTT
      addCheck(
        "do-reachable",
        "pass",
        `DO reachable (RTT: ${probe.doRttMs}ms)`,
      );

      // Check 4: R2 reachable
      if (probe.r2Reachable) {
        addCheck("r2-reachable", "pass", "R2 reachable");
      } else {
        addCheck("r2-reachable", "fail", "R2 not reachable");
      }

      // Check 5: Expired claims
      if (probe.doHealth.expiredClaimsCount === 0) {
        addCheck("expired-claims", "pass", "No expired claims pending sweep");
      } else {
        addCheck(
          "expired-claims",
          "warn",
          `${probe.doHealth.expiredClaimsCount} expired claim(s) pending sweep`,
        );
      }

      // Check 6: Journal size
      if (probe.doHealth.journalRows < JOURNAL_WARN_THRESHOLD) {
        addCheck(
          "journal-size",
          "pass",
          `Journal size: ${probe.doHealth.journalRows} rows (max seq: ${probe.doHealth.maxSeq})`,
        );
      } else {
        addCheck(
          "journal-size",
          "warn",
          `Journal has ${probe.doHealth.journalRows} rows (threshold: ${JOURNAL_WARN_THRESHOLD}, max seq: ${probe.doHealth.maxSeq})`,
        );
      }
    } catch (err) {
      // Probe failed -- DO unreachable, mark all DO-dependent checks as fail
      addCheck(
        "do-reachable",
        "fail",
        `DO not reachable: ${err instanceof Error ? err.message : String(err)}`,
      );
      addCheck("r2-reachable", "fail", "Skipped (probe failed)");
      addCheck("expired-claims", "fail", "Skipped (probe failed)");
      addCheck("journal-size", "fail", "Skipped (probe failed)");
    }

    // Check 7: DO SQLite schema diagnostic
    try {
      const schemaPath = `/projects/${ctx.config.project_id}/doctor/schema`;
      const schemaReport = await client.get(schemaPath, {
        schema: DoctorSchemaResponseSchema,
        validate: true,
      });

      if (!("sqlite_version" in schemaReport)) {
        addCheck(
          "schema-diagnostic",
          "warn",
          "DO schema diagnostic unavailable: DO is still running old code",
        );
      } else {
        const missing = findMissingSchemaColumns(schemaReport.columns);
        if (missing.length > 0) {
          addCheck(
            "schema-diagnostic",
            "fail",
            `DO schema drift: missing ${missing.join(", ")}`,
          );
        } else {
          const versions = schemaReport.migrations.map((m) => m.version);
          const latestVersion = versions.length > 0 ? Math.max(...versions) : 0;
          const versionSuffix = schemaReport.do_code_version
            ? `, DO code: ${schemaReport.do_code_version}`
            : "";
          addCheck(
            "schema-diagnostic",
            "pass",
            `DO schema ok (${schemaReport.migrations.length} migrations applied, latest: ${latestVersion}, SQLite: ${schemaReport.sqlite_version}${versionSuffix})`,
          );
        }
      }
    } catch (err) {
      addCheck(
        "schema-diagnostic",
        "fail",
        `Schema diagnostic failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Check 8: GitHub App (when auth mode is github-repo)
    const authMode7 = ctx.config?.auth?.mode ?? "tila-token";
    if (authMode7 === "github-repo") {
      const infraDir = tilaHome();
      if (!existsSync(infraDir)) {
        addCheck(
          "github-app-local",
          "fail",
          "GitHub App: no ~/.tila directory found",
        );
      } else {
        const appConfigPath = join(infraDir, "github-app.json");
        if (!existsSync(appConfigPath)) {
          addCheck(
            "github-app-local",
            "fail",
            "GitHub App: not configured locally (.tila/github-app.json missing)",
          );
        } else {
          // Read and validate local config
          try {
            const configContent = readFileSync(appConfigPath, "utf-8");
            const localConfig = JSON.parse(configContent);
            if (
              !localConfig.app_id ||
              !localConfig.client_id ||
              !localConfig.pem
            ) {
              addCheck(
                "github-app-local",
                "fail",
                "GitHub App: invalid local config (missing required fields)",
              );
            } else {
              addCheck(
                "github-app-local",
                "pass",
                `GitHub App: local config valid (app_id: ${localConfig.app_id})`,
              );

              // Check Worker config
              try {
                const appInfoUrl = `${ctx.config.worker_url}/api/auth/github/app-info`;
                const res = await fetch(appInfoUrl);
                if (!res.ok) {
                  addCheck(
                    "github-app-worker",
                    "fail",
                    `GitHub App: Worker endpoint unreachable (${res.status})`,
                  );
                } else {
                  const json = await res.json();
                  const parsed = GitHubAppInfoResponseSchema.parse(json);
                  if (parsed.app_id === localConfig.app_id) {
                    addCheck(
                      "github-app-worker",
                      "pass",
                      `GitHub App: Worker config matches local (app_id: ${parsed.app_id})`,
                    );
                  } else {
                    addCheck(
                      "github-app-worker",
                      "warn",
                      `GitHub App: app_id mismatch (local: ${localConfig.app_id}, worker: ${parsed.app_id})`,
                    );
                  }
                }
              } catch (err) {
                addCheck(
                  "github-app-worker",
                  "fail",
                  `GitHub App: Worker endpoint unreachable (${err instanceof Error ? err.message : String(err)})`,
                );
              }
            }
          } catch (err) {
            addCheck(
              "github-app-local",
              "fail",
              `GitHub App: failed to read local config (${err instanceof Error ? err.message : String(err)})`,
            );
          }
        }
      }
    }

    // Check 9: Reconcile (optional, --reconcile flag)
    const doReconcile = !!(args.reconcile || args.apply);
    if (doReconcile) {
      try {
        const reconcilePath = `/projects/${ctx.config.project_id}/artifacts/reconcile`;
        const query: Record<string, string | undefined> = {};
        if (args.apply) {
          query.apply = "true";
        }
        const report = await client.request("POST", reconcilePath, {
          schema: ReconcileReportSchema,
          query,
        });

        if (report.orphans_found === 0) {
          addCheck("reconcile", "pass", "Reconcile: 0 orphans found");
        } else {
          const recoverableCount =
            report.orphans_found - report.orphans_unrecoverable;
          const detailLines = report.details.map((d) => {
            if (d.status === "recovered") return `  recovered: ${d.key}`;
            if (d.status === "skipped") return `  skipped (dry-run): ${d.key}`;
            return `  unrecoverable: ${d.key}${d.reason ? ` (${d.reason})` : ""}`;
          });
          const summary = `Reconcile: ${report.orphans_found} orphans, ${recoverableCount} recoverable, ${report.orphans_unrecoverable} unrecoverable`;
          const detail =
            detailLines.length > 0
              ? `${summary}\n${detailLines.join("\n")}`
              : summary;
          addCheck(
            "reconcile",
            report.orphans_unrecoverable > 0 ? "warn" : "pass",
            detail,
          );
          if (args.apply && report.orphans_recovered > 0) {
            addCheck(
              "reconcile-applied",
              "pass",
              `Reconcile: ${report.orphans_recovered} pointer(s) recovered`,
            );
          }
        }
      } catch (err) {
        addCheck(
          "reconcile",
          "fail",
          `Reconcile check failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Check 10: Search drift (optional, --search-drift flag)
    if (args["search-drift"]) {
      try {
        const driftPath = `/projects/${ctx.config.project_id}/doctor/search-drift`;
        const report = await client.get(driftPath, {
          schema: SearchDriftReportSchema,
          validate: true,
        });
        for (const finding of report.findings) {
          const examples = finding.examples.slice(0, 3);
          const detail =
            examples.length > 0
              ? `${finding.detail}\n${examples.map((ex) => `  ${ex}`).join("\n")}`
              : finding.detail;
          addCheck(finding.check, finding.status, detail);
        }
      } catch (err) {
        addCheck(
          "search-drift",
          "fail",
          `Search drift check failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Check 11: Search rebuild (optional, --search-rebuild flag)
    const doSearchRebuild = !!args["search-rebuild"];
    if (doSearchRebuild) {
      try {
        const rebuildPath = `/projects/${ctx.config.project_id}/artifacts/search-rebuild`;
        const query: Record<string, string | undefined> = {};
        if (args.apply) {
          query.apply = "true";
        }
        const report = await client.request("POST", rebuildPath, {
          schema: SearchRebuildReportSchema,
          query,
        });

        if (report.candidates_found === 0) {
          addCheck(
            "search-rebuild",
            "pass",
            "Search rebuild: 0 candidates found",
          );
        } else {
          const detailLines = report.details.map(
            (d) =>
              `  ${d.status}: ${d.artifact_key}${d.reason ? ` (${d.reason})` : ""}`,
          );
          const summary = `Search rebuild: ${report.candidates_found} candidates, ${report.written} written, ${report.tombstoned} tombstoned, ${report.unrecoverable} unrecoverable`;
          const detail =
            detailLines.length > 0
              ? `${summary}\n${detailLines.join("\n")}`
              : summary;
          addCheck(
            "search-rebuild",
            report.unrecoverable > 0 ? "warn" : "pass",
            detail,
          );
          if (args.apply && report.written > 0) {
            addCheck(
              "search-rebuild-applied",
              "pass",
              `Search rebuild: ${report.written} search doc(s) written`,
            );
          }
        }
      } catch (err) {
        addCheck(
          "search-rebuild",
          "fail",
          `Search rebuild failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Summary
    const passed = checks.filter((c) => c.status === "pass").length;
    const warned = checks.filter((c) => c.status === "warn").length;
    const failed = checks.filter((c) => c.status === "fail").length;

    s?.stop("Checks complete.");

    if (jsonMode) {
      printJson({ checks, summary: { passed, warned, failed } });
    } else {
      const lines = checks.map((check) => {
        if (check.status === "pass") return `${c.green("✓")} ${check.detail}`;
        if (check.status === "warn")
          return `${c.yellow("!")} ${c.yellow(check.detail)}`;
        return `${c.red("✗")} ${c.red(check.detail)}`;
      });
      p.note(lines.join("\n"), "Health check");

      if (failed > 0) {
        p.log.error(`${passed} passed, ${warned} warnings, ${failed} errors`);
      } else if (warned > 0) {
        p.log.warn(`${passed} passed, ${warned} warnings`);
      } else {
        p.log.info(`${passed} passed`);
      }
    }

    // Exit code: 0=all pass, 1=any warn, 2=any fail
    if (failed > 0) {
      process.exit(2);
    } else if (warned > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  },
});
