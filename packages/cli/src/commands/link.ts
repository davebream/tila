/**
 * `tila link <worker_url>` — net-new registration + trust gesture (Task 9, WI-L).
 *
 * Registers an instance, marks it trusted, builds a CredentialRecord from the
 * provided token (--token or prompt), and stores it in the keychain via putCredential.
 * Also writes the derived instance_key into the existing nested
 * config.instance.instance_key field in .tila/config.toml when a repo config exists.
 *
 * Instance key derivation:
 * - Explicit: --instance <key> (instance_id_source: "server")
 * - Derived:  canonicalizeWorkerUrl(worker_url) host-based slug
 *             (instance_id_source: "client-uuid")
 *
 * CI/non-TTY: putCredential throws CredentialWriteRefusedError — surfaced as non-zero exit.
 *
 * SINGLE-WRITER INVARIANT: does not call setCurrentContext directly.
 */

import {
  CredentialWriteRefusedError,
  InvalidWorkerUrlError,
  canonicalizeWorkerUrl,
} from "@tila/auth-store";
import type { CredentialRecord, InstanceKey } from "@tila/schemas";
import { defineCommand } from "citty";
import { findConfig, writeConfigFile } from "../config";
import { globalFlagArgs } from "../lib/global-flags";
import {
  buildAuthStore,
  maybePromoteLegacyAfterWrite,
} from "../lib/instance-context";
import {
  eprintln,
  jsonArg,
  printJsonError,
  printJsonSuccess,
} from "../lib/output";

export default defineCommand({
  meta: {
    name: "link",
    description:
      "Register and trust a tila instance, storing a credential in the keychain",
  },
  args: {
    worker_url: {
      type: "positional" as const,
      description: "Worker URL of the tila instance to link",
      required: true,
    },
    // Note: --token, --instance come from ...globalFlagArgs below.
    // --token is the bearer token to store; --instance overrides the derived key.
    expires: {
      type: "string" as const,
      description:
        "Token expiry as epoch ms (default: non-expiring = far future)",
      required: false,
    },
    label: {
      type: "string" as const,
      description: "Human-readable label for the instance",
      required: false,
    },
    ...jsonArg,
    ...globalFlagArgs,
  },
  async run({ args }) {
    const workerUrl = args.worker_url as string;
    const authStore = buildAuthStore();

    // --- Step 1: Canonicalize the worker_url and derive the instance key ---
    let canonicalUrl: string;
    try {
      canonicalUrl = canonicalizeWorkerUrl(workerUrl);
    } catch (err) {
      const msg =
        err instanceof InvalidWorkerUrlError
          ? err.message
          : `Invalid worker_url: ${workerUrl}`;
      if (args.json) {
        printJsonError(msg, "invalid-worker-url", undefined, 1);
      } else {
        eprintln(`Error: ${msg}`);
        process.exit(1);
      }
      return;
    }

    // Instance key: explicit --instance flag or derived from canonical URL host
    let instanceKey: InstanceKey;
    let instanceIdSource: "server" | "client-uuid";
    if (args.instance) {
      instanceKey = args.instance as InstanceKey;
      instanceIdSource = "server";
    } else {
      // Derive a stable key from the canonical URL's host part (no scheme/path)
      const parsedUrl = new URL(canonicalUrl);
      instanceKey = parsedUrl.host as InstanceKey;
      instanceIdSource = "client-uuid";
    }

    // --- Step 2: Acquire the raw token ---
    let rawToken = args.token as string | undefined;
    if (!rawToken) {
      // Prompt for the token interactively
      const { createInterface } = await import("node:readline");
      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
        terminal: false,
      });
      rawToken = await new Promise<string>((resolve) => {
        process.stderr.write("Bearer token: ");
        rl.once("line", (line) => {
          rl.close();
          resolve(line.trim());
        });
      });
    }

    if (!rawToken || rawToken.trim().length === 0) {
      const msg = "No token provided. Aborting.";
      if (args.json) {
        printJsonError(msg, "no-token", undefined, 1);
      } else {
        eprintln(`Error: ${msg}`);
        process.exit(1);
      }
      return;
    }

    // --- Step 3: Register → markTrusted → putCredential ---
    try {
      await authStore.registerInstance({
        instance_key: instanceKey,
        instance_id_source: instanceIdSource,
        worker_url: canonicalUrl,
        ...(args.label ? { label: args.label as string } : {}),
      });

      await authStore.markTrusted(instanceKey);

      const now = Date.now();
      // expires_at: use explicit value or a non-expiring far future (100 years)
      const expiresAt = args.expires
        ? Number.parseInt(args.expires as string, 10)
        : now + 100 * 365 * 24 * 60 * 60 * 1000;

      const credRecord: CredentialRecord = {
        instance_key: instanceKey,
        token: rawToken.trim(),
        token_type: "Bearer",
        expires_at: expiresAt,
        obtained_at: now,
      };

      await authStore.putCredential(instanceKey, credRecord);
    } catch (err) {
      // Note: maybePromoteLegacyAfterWrite is NOT called here — the primary action failed.
      if (err instanceof CredentialWriteRefusedError) {
        const reason = err.message.includes("CI")
          ? "CI environments cannot write credentials to the keychain. Use --token inline or TILA_TOKEN env var."
          : "Non-TTY environments cannot write credentials to the keychain. Use --token inline or TILA_TOKEN env var.";
        if (args.json) {
          printJsonError(reason, "credential-write-refused", undefined, 1);
        } else {
          eprintln(`Error: ${reason}`);
          process.exit(1);
        }
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (args.json) {
        printJsonError(msg, "link-failed", undefined, 1);
      } else {
        eprintln(`Error: ${msg}`);
        process.exit(1);
      }
      return;
    }

    // --- Step 4: Write instance_key into .tila/config.toml if a repo config exists ---
    try {
      const config = findConfig();
      if (config) {
        const updatedConfig = {
          ...config,
          instance: {
            ...config.instance,
            instance_key: instanceKey,
          },
        };
        // Find the .tila dir relative to cwd
        const { findTilaDir } = await import("../config");
        const tilaDir = findTilaDir() ?? ".tila";
        writeConfigFile(updatedConfig, tilaDir);
      }
    } catch {
      // Best-effort: config write failure is non-fatal
      eprintln(
        "Warning: Could not update .tila/config.toml with instance_key. Credential was stored successfully.",
      );
    }

    // --- Step 4b: Best-effort lazy legacy promotion (WI-M, C3) ---
    // Fire-and-forget after the primary write succeeds; errors are swallowed inside.
    await maybePromoteLegacyAfterWrite(authStore, canonicalUrl);

    // --- Step 5: Success output ---
    if (args.json) {
      printJsonSuccess({
        instance_key: instanceKey,
        worker_url: canonicalUrl,
        trusted: true,
      });
    } else {
      console.log(`Linked instance "${instanceKey}" → ${canonicalUrl}`);
      console.log(
        "Run `tila auth status` to verify or `tila switch` to set as current.",
      );
    }
  },
});
