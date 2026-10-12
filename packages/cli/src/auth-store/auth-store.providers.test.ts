/**
 * Tests for AuthStore provider mutator (WI-K / C2 — Task 2)
 *
 * Covers:
 * - setCredentialProvider sets the field on the instance record
 * - setCredentialProvider leaves worker_url / instance_id_source / instance_key / trust untouched
 * - After setCredentialProvider then markTrusted, re-read shows credential_provider intact
 *   (no silent drop on TOML rewrite)
 * - setCredentialProvider throws InstanceNotFoundError for unknown key
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InstanceKey } from "@tila/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore } from "./auth-store.js";
import { InstanceNotFoundError } from "./errors.js";
import { TilaPaths } from "./paths.js";
import { FakeSecretStore } from "./testing.js";

let tmpDir: string;
let paths: TilaPaths;
let secrets: FakeSecretStore;
let store: AuthStore;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "tila-providers-test-"));
  process.env.TILA_HOME = tmpDir;
  paths = new TilaPaths();
  secrets = new FakeSecretStore();
  store = new AuthStore({
    paths,
    secrets,
    env: { isCI: false, isTTY: true },
  });
});

afterEach(() => {
  process.env.TILA_HOME = undefined;
  rmSync(tmpDir, { recursive: true, force: true });
});

const makeKey = (s: string) => s as InstanceKey;

describe("AuthStore.setCredentialProvider", () => {
  it("sets credential_provider on an existing instance record", async () => {
    const key = makeKey("provider-key-001");
    await store.registerInstance({
      instance_key: key,
      instance_id_source: "server",
      worker_url: "https://worker.example.com",
    });

    await store.setCredentialProvider(key, { kind: "github" });

    const record = await store.getInstance(key);
    expect(record?.credential_provider?.kind).toBe("github");
  });

  it("leaves worker_url, instance_id_source, instance_key, and trust unchanged", async () => {
    const key = makeKey("provider-key-002");
    const original = await store.registerInstance({
      instance_key: key,
      instance_id_source: "server",
      worker_url: "https://worker.example.com",
      label: "Test",
    });

    await store.setCredentialProvider(key, { kind: "tila-token" });

    const record = await store.getInstance(key);
    expect(record?.instance_key).toBe(original.instance_key);
    expect(record?.worker_url).toBe(original.worker_url);
    expect(record?.instance_id_source).toBe(original.instance_id_source);
    expect(record?.trust.trusted).toBe(original.trust.trusted);
    expect(record?.trust.trusted_at).toBe(original.trust.trusted_at);
    expect(record?.created_at).toBe(original.created_at);
  });

  it("sets exec credential_provider with command and args", async () => {
    const key = makeKey("provider-key-003");
    await store.registerInstance({
      instance_key: key,
      instance_id_source: "server",
      worker_url: "https://worker.example.com",
    });

    await store.setCredentialProvider(key, {
      kind: "exec",
      command: "/usr/local/bin/my-helper",
      args: ["--format", "json"],
    });

    const record = await store.getInstance(key);
    expect(record?.credential_provider?.kind).toBe("exec");
    if (record?.credential_provider?.kind === "exec") {
      expect(record.credential_provider.command).toBe(
        "/usr/local/bin/my-helper",
      );
      expect(record.credential_provider.args).toEqual(["--format", "json"]);
    }
  });

  it("throws InstanceNotFoundError for unknown key", async () => {
    const unknownKey = makeKey("nonexistent-key");
    await expect(
      store.setCredentialProvider(unknownKey, { kind: "github" }),
    ).rejects.toBeInstanceOf(InstanceNotFoundError);
  });

  it("credential_provider survives a subsequent markTrusted rewrite (no silent drop)", async () => {
    const key = makeKey("provider-key-004");
    await store.registerInstance({
      instance_key: key,
      instance_id_source: "server",
      worker_url: "https://worker.example.com",
    });

    // Set credential_provider first
    await store.setCredentialProvider(key, {
      kind: "oidc-generic",
      issuer: "https://accounts.example.com",
      client_id: "client-abc",
      scope: "openid profile",
    });

    // Then markTrusted rewrites the full record — credential_provider must survive
    await store.markTrusted(key);

    const record = await store.getInstance(key);
    expect(record?.trust.trusted).toBe(true);
    expect(record?.credential_provider?.kind).toBe("oidc-generic");
    if (record?.credential_provider?.kind === "oidc-generic") {
      expect(record.credential_provider.issuer).toBe(
        "https://accounts.example.com",
      );
      expect(record.credential_provider.client_id).toBe("client-abc");
    }
  });

  it("can update credential_provider to a new value", async () => {
    const key = makeKey("provider-key-005");
    await store.registerInstance({
      instance_key: key,
      instance_id_source: "server",
      worker_url: "https://worker.example.com",
    });

    await store.setCredentialProvider(key, { kind: "github" });
    await store.setCredentialProvider(key, { kind: "tila-token" });

    const record = await store.getInstance(key);
    expect(record?.credential_provider?.kind).toBe("tila-token");
  });
});
