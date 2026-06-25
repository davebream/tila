/**
 * Tests for AuthStore registry tier (Task 9 — Phase 4)
 *
 * Covers:
 * - register → get → list
 * - current_context set / get
 * - immutable re-register throws ImmutableInstanceKeyError
 * - markTrusted flips trust
 * - setCurrentContext on unknown instance behavior
 * - new instances start with trust.trusted: false
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InstanceKey } from "@tila/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore } from "./auth-store.js";
import { ImmutableInstanceKeyError, InstanceNotFoundError } from "./errors.js";
import { TilaPaths } from "./paths.js";
import { FakeSecretStore } from "./testing.js";

let tmpDir: string;
let paths: TilaPaths;
let secrets: FakeSecretStore;
let store: AuthStore;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "tila-test-"));
  // Override TILA_HOME to point at the temp dir
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

describe("AuthStore registry tier", () => {
  it("registers an instance and retrieves it via getInstance", async () => {
    const key = makeKey("test-key-001");
    const rec = await store.registerInstance({
      instance_key: key,
      instance_id_source: "server",
      worker_url: "https://worker.example.com",
      label: "Test Instance",
    });

    expect(rec.instance_key).toBe(key);
    expect(rec.label).toBe("Test Instance");
    expect(rec.worker_url).toBe("https://worker.example.com");
    expect(rec.instance_id_source).toBe("server");
    expect(rec.trust.trusted).toBe(false);
    expect(rec.trust.trusted_at).toBeNull();

    const fetched = await store.getInstance(key);
    expect(fetched).not.toBeNull();
    expect(fetched?.instance_key).toBe(key);
    expect(fetched?.label).toBe("Test Instance");
  });

  it("new instances start with trust.trusted: false", async () => {
    const key = makeKey("untrusted-key-001");
    const rec = await store.registerInstance({
      instance_key: key,
      instance_id_source: "client-uuid",
      worker_url: "https://worker.example.com",
    });

    expect(rec.trust.trusted).toBe(false);
    expect(rec.trust.trusted_at).toBeNull();
  });

  it("listInstances returns all registered instances", async () => {
    const key1 = makeKey("key-list-001");
    const key2 = makeKey("key-list-002");

    await store.registerInstance({
      instance_key: key1,
      instance_id_source: "server",
      worker_url: "https://worker1.example.com",
    });
    await store.registerInstance({
      instance_key: key2,
      instance_id_source: "client-uuid",
      worker_url: "https://worker2.example.com",
    });

    const list = await store.listInstances();
    expect(list).toHaveLength(2);
    const keys = list.map((r) => r.instance_key);
    expect(keys).toContain(key1);
    expect(keys).toContain(key2);
  });

  it("getInstance returns null for an unknown key", async () => {
    const result = await store.getInstance(makeKey("nonexistent-key"));
    expect(result).toBeNull();
  });

  it("getCurrentContext returns null when no context is set", async () => {
    const ctx = await store.getCurrentContext();
    expect(ctx).toBeNull();
  });

  it("setCurrentContext and getCurrentContext round-trip", async () => {
    const key = makeKey("ctx-key-001");
    await store.registerInstance({
      instance_key: key,
      instance_id_source: "server",
      worker_url: "https://worker.example.com",
    });

    await store.setCurrentContext(key);
    const ctx = await store.getCurrentContext();
    expect(ctx).toBe(key);
  });

  it("setCurrentContext to null clears the context", async () => {
    const key = makeKey("ctx-key-002");
    await store.registerInstance({
      instance_key: key,
      instance_id_source: "server",
      worker_url: "https://worker.example.com",
    });
    await store.setCurrentContext(key);
    await store.setCurrentContext(null);
    const ctx = await store.getCurrentContext();
    expect(ctx).toBeNull();
  });

  it("setCurrentContext on unknown instance throws InstanceNotFoundError", async () => {
    await expect(
      store.setCurrentContext(makeKey("ghost-key")),
    ).rejects.toBeInstanceOf(InstanceNotFoundError);
  });

  it("re-registering with the same key is idempotent (returns existing)", async () => {
    const key = makeKey("idem-key-001");
    const first = await store.registerInstance({
      instance_key: key,
      instance_id_source: "server",
      worker_url: "https://worker.example.com",
      label: "First",
    });

    // Same key, same details — should return existing record
    const second = await store.registerInstance({
      instance_key: key,
      instance_id_source: "server",
      worker_url: "https://worker.example.com",
      label: "First",
    });

    expect(second.instance_key).toBe(first.instance_key);
    expect(second.created_at).toBe(first.created_at);
  });

  it("re-registering with a different worker_url throws ImmutableInstanceKeyError", async () => {
    const key = makeKey("immutable-key-001");
    await store.registerInstance({
      instance_key: key,
      instance_id_source: "server",
      worker_url: "https://worker.example.com",
    });

    await expect(
      store.registerInstance({
        instance_key: key,
        instance_id_source: "server",
        worker_url: "https://OTHER-worker.example.com",
      }),
    ).rejects.toBeInstanceOf(ImmutableInstanceKeyError);
  });

  it("re-registering with same key+worker_url but different instance_id_source throws ImmutableInstanceKeyError", async () => {
    const key = makeKey("immutable-key-source-001");
    await store.registerInstance({
      instance_key: key,
      instance_id_source: "server",
      worker_url: "https://worker.example.com",
    });

    // Same key and worker_url, but different instance_id_source — must throw
    await expect(
      store.registerInstance({
        instance_key: key,
        instance_id_source: "client-uuid",
        worker_url: "https://worker.example.com",
      }),
    ).rejects.toBeInstanceOf(ImmutableInstanceKeyError);
  });

  it("re-registering with same key+worker_url+instance_id_source but different label is idempotent (label ignored)", async () => {
    const key = makeKey("label-only-diff-key-001");
    const first = await store.registerInstance({
      instance_key: key,
      instance_id_source: "server",
      worker_url: "https://worker.example.com",
      label: "Original Label",
    });

    // Same immutable identity, only label differs — silently returns existing record
    const second = await store.registerInstance({
      instance_key: key,
      instance_id_source: "server",
      worker_url: "https://worker.example.com",
      label: "New Label",
    });

    expect(second.created_at).toBe(first.created_at);
    // Label is not updated — existing record returned unchanged
    expect(second.label).toBe("Original Label");
  });

  it("markTrusted flips trust.trusted to true and records trusted_at", async () => {
    const key = makeKey("trust-key-001");
    await store.registerInstance({
      instance_key: key,
      instance_id_source: "server",
      worker_url: "https://worker.example.com",
    });

    const before = await store.getInstance(key);
    expect(before?.trust.trusted).toBe(false);

    await store.markTrusted(key);

    const after = await store.getInstance(key);
    expect(after?.trust.trusted).toBe(true);
    expect(after?.trust.trusted_at).toBeTypeOf("number");
    expect(after?.trust.trusted_at).toBeGreaterThan(0);
  });

  it("markTrusted throws InstanceNotFoundError for unknown key", async () => {
    await expect(
      store.markTrusted(makeKey("ghost-mark")),
    ).rejects.toBeInstanceOf(InstanceNotFoundError);
  });

  // --------------------------------------------------------------------------
  // deleteInstance (Task 7a)
  // --------------------------------------------------------------------------

  it("deleteInstance removes the instance from the registry", async () => {
    const key = makeKey("del-key-001");
    await store.registerInstance({
      instance_key: key,
      instance_id_source: "server",
      worker_url: "https://worker.example.com",
    });

    await store.deleteInstance(key);

    expect(await store.getInstance(key)).toBeNull();
    const list = await store.listInstances();
    expect(list.every((r) => r.instance_key !== key)).toBe(true);
  });

  it("deleteInstance clears current_context when it pointed at the deleted key", async () => {
    const key = makeKey("del-ctx-key-001");
    await store.registerInstance({
      instance_key: key,
      instance_id_source: "server",
      worker_url: "https://worker.example.com",
    });
    await store.setCurrentContext(key);
    expect(await store.getCurrentContext()).toBe(key);

    await store.deleteInstance(key);

    expect(await store.getCurrentContext()).toBeNull();
    expect(await store.getInstance(key)).toBeNull();
  });

  it("deleteInstance does not clear current_context when it points at a different key", async () => {
    const key1 = makeKey("del-other-001");
    const key2 = makeKey("del-other-002");
    await store.registerInstance({
      instance_key: key1,
      instance_id_source: "server",
      worker_url: "https://worker1.example.com",
    });
    await store.registerInstance({
      instance_key: key2,
      instance_id_source: "server",
      worker_url: "https://worker2.example.com",
    });
    await store.setCurrentContext(key2);

    await store.deleteInstance(key1);

    expect(await store.getCurrentContext()).toBe(key2);
    expect(await store.getInstance(key1)).toBeNull();
    expect(await store.getInstance(key2)).not.toBeNull();
  });

  it("deleteInstance is idempotent on an absent key (does not throw)", async () => {
    await expect(
      store.deleteInstance(makeKey("nonexistent-del-key")),
    ).resolves.toBeUndefined();
  });
});
