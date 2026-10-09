import { chmod, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  RuntimeEnrollmentStore,
  RuntimeFileSecretStore,
} from "./runtime-store";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
it("stores installation authority separately and verifies exact deployment/project/enrollment binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "tila-runtime-store-"));
  roots.push(root);
  const store = new RuntimeEnrollmentStore(new RuntimeFileSecretStore(root));
  await store.probe();
  const value = {
    version: 1 as const,
    deployment: "https://tila.test",
    instanceId: crypto.randomUUID(),
    projectId: "p",
    enrollmentId: crypto.randomUUID(),
    installationId: crypto.randomUUID(),
    privateJwk: { d: "test-private" },
    token: "test-enrollment",
  };
  await store.save(value);
  expect(await store.get(value.instanceId, "p", value.enrollmentId)).toEqual(
    value,
  );
  expect(
    await store.get(value.instanceId, "other", value.enrollmentId),
  ).toBeNull();
  expect(
    await store.get(crypto.randomUUID(), "p", value.enrollmentId),
  ).toBeNull();
  await store.remove(value.instanceId, "p", value.enrollmentId);
  expect(await store.get(value.instanceId, "p", value.enrollmentId)).toBeNull();
});
it("rejects permissive and symlinked secret directories without falling back", async () => {
  const root = await mkdtemp(join(tmpdir(), "tila-runtime-mode-"));
  roots.push(root);
  await chmod(root, 0o755);
  await expect(
    new RuntimeFileSecretStore(root).set("service", "account", "secret"),
  ).rejects.toThrow("0700");
  await chmod(root, 0o700);
  const link = `${root}-link`;
  roots.push(link);
  await symlink(root, link);
  await expect(
    new RuntimeFileSecretStore(link).get("service", "account"),
  ).rejects.toThrow("0700");
});
