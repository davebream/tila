/**
 * `tila auth` command group — READ PATH (Phase 2, WI-L).
 *
 * Subcommands:
 *   auth status  — list instances, show which resolves here (AC-1, AC-5)
 *   auth token   — emit bare token to stdout, diagnostics to stderr (AC-2, AC-5)
 *
 * SECURITY INVARIANT: neither subcommand ever writes a raw token to any output
 * path other than process.stdout.write (auth token, non-json mode).
 * auth status uses toInstanceMetadata() which strips the credential field.
 */

import type { InstanceRecord } from "@tila/schemas";
import { defineCommand } from "citty";
import { globalFlagArgs } from "../lib/global-flags";
import {
  buildAuthStore,
  resolveInstanceContext,
  toInstanceMetadata,
} from "../lib/instance-context";
import {
  eprintJson,
  eprintln,
  formatExpiry,
  formatResolvesHere,
  formatTrust,
  jsonArg,
  printJson,
  printJsonSuccess,
  renderTable,
} from "../lib/output";

// ---------------------------------------------------------------------------
// auth status
// ---------------------------------------------------------------------------

const statusCmd = defineCommand({
  meta: {
    name: "status",
    description:
      "Show all registered instances, trust, expiry, and which resolves here",
  },
  args: {
    "all-instances": {
      type: "boolean" as const,
      description: "Show all instances (default: show resolved/current only)",
      default: false,
    },
    ...jsonArg,
    ...globalFlagArgs,
  },
  async run({ args }) {
    const authStore = buildAuthStore();
    const instances: InstanceRecord[] = await authStore.listInstances();
    const currentContext = await authStore.getCurrentContext();

    // Determine which instance resolves in this environment
    const outcome = await resolveInstanceContext({ authStore });
    const resolvedKey = outcome.ok ? outcome.instance.instance_key : null;

    if (args.json) {
      // Build safe per-instance metadata for JSON (no tokens)
      const instancesJson = await Promise.all(
        instances.map(async (inst) => {
          let expiresAt: number | null = null;
          try {
            const cred = await authStore.getCredential(inst.instance_key, {
              allowExpired: true,
            });
            expiresAt = cred?.expires_at ?? null;
          } catch {
            // keychain unavailable — degrade gracefully
          }
          return {
            instance_key: inst.instance_key,
            label: inst.label ?? null,
            worker_url: inst.worker_url,
            trust: inst.trust,
            expires_at: expiresAt,
            is_current: inst.instance_key === currentContext,
            resolves_here: inst.instance_key === resolvedKey,
          };
        }),
      );

      // Safe projection — never serialise credential
      const resolved = outcome.ok ? toInstanceMetadata(outcome.instance) : null;

      printJsonSuccess({
        current_context: currentContext,
        resolved,
        instances: instancesJson,
      });
      return;
    }

    // Table output
    if (instances.length === 0) {
      console.log(
        "No instances registered. Run `tila link <worker_url>` to register one.",
      );
      return;
    }

    const rows = await Promise.all(
      instances.map(async (inst) => {
        let expiresAt: number | null = null;
        try {
          const cred = await authStore.getCredential(inst.instance_key, {
            allowExpired: true,
          });
          expiresAt = cred?.expires_at ?? null;
        } catch {
          // keychain unavailable — degrade
        }

        const isHere = inst.instance_key === resolvedKey;
        const isCurrent = inst.instance_key === currentContext;

        return {
          key: `${inst.instance_key}${isCurrent ? " ◀" : ""}`,
          label: inst.label ?? "—",
          worker_url: inst.worker_url,
          trust: formatTrust(
            inst.trust.trusted
              ? { kind: "trusted" as const }
              : {
                  kind: "untrusted-needs-login" as const,
                  reason: "not-trusted" as const,
                },
          ),
          expiry: formatExpiry(expiresAt),
          here: formatResolvesHere(isHere),
        };
      }),
    );

    renderTable(rows, [
      { key: "key", label: "Key" },
      { key: "label", label: "Label" },
      { key: "worker_url", label: "Worker URL" },
      { key: "trust", label: "Trust" },
      { key: "expiry", label: "Expiry" },
      { key: "here", label: "Resolves Here?" },
    ]);
  },
});

// ---------------------------------------------------------------------------
// auth token
// ---------------------------------------------------------------------------

const tokenCmd = defineCommand({
  meta: {
    name: "token",
    description:
      "Emit the resolved bearer token to stdout (credential-helper mode)",
  },
  args: {
    ...jsonArg,
    ...globalFlagArgs,
  },
  async run({ args }) {
    const outcome = await resolveInstanceContext();

    if (!outcome.ok) {
      const msg = outcome.error.message;
      if (args.json) {
        // Error envelope to stderr (stdout must stay clean)
        eprintJson({
          ok: false,
          code: "instance-resolution-failed",
          message: msg,
        });
      } else {
        eprintln(`Error: ${msg}`);
        eprintln(
          "Hint: run `tila auth status` to diagnose or `tila link <url>` to register.",
        );
      }
      process.exit(1);
      return;
    }

    const { instance } = outcome;
    const cred = instance.credential;

    // Extract raw token from the union
    const token =
      cred.source === "inline-token" ? cred.token : cred.record.token;

    if (args.json) {
      // JSON goes to stdout (opt-in)
      if (cred.source === "inline-token") {
        printJson({
          token,
          token_type: "Bearer",
          expires_at: null,
          instance_key: null,
          source: "inline-token",
        });
      } else {
        printJson({
          token: cred.record.token,
          token_type: cred.record.token_type,
          expires_at: cred.record.expires_at,
          instance_key: instance.instance_key,
          source: "keychain",
        });
      }
      return;
    }

    // Non-JSON: diagnostics to stderr, bare token to stdout
    eprintln(
      `source: ${cred.source}${instance.instance_key ? ` (${instance.instance_key})` : ""}`,
    );
    if (cred.source === "keychain") {
      eprintln(`expiry: ${formatExpiry(cred.record.expires_at)}`);
    }

    // SECURITY: bare token + newline ONLY to stdout; nothing else goes here
    process.stdout.write(`${token}\n`);
  },
});

// ---------------------------------------------------------------------------
// auth command group
// ---------------------------------------------------------------------------

export default defineCommand({
  meta: {
    name: "auth",
    description: "Manage tila authentication (instances, tokens, status)",
  },
  subCommands: {
    status: statusCmd,
    token: tokenCmd,
  },
});
