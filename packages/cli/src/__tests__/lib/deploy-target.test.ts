import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstanceKey, PerSlugInfraMeta } from "@tila/schemas";
import { stringify } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStore, TilaPaths } from "../../auth-store";
import { writeRegistry } from "../../auth-store/registry-file";
import { writeConfigFile } from "../../config";
import type { Cloudflare } from "../../lib/cloudflare-client";
import { resolveDeployTarget } from "../../lib/deploy-target";

let root: string;
let home: string;
let originalCwd: string;
let store: AuthStore;
const secretGet = vi.fn(() => {
  throw new Error("keychain must not be accessed");
});
const settings = vi.fn();
const domains = vi.fn();
const subdomains = vi.fn();
const cf = {
  workers: {
    subdomains: { get: subdomains },
    domains: { list: domains },
    scripts: { scriptAndVersionSettings: { get: settings } },
  },
} as unknown as Cloudflare;
const urlA = "https://a.acct.workers.dev";
const urlB = "https://b.acct.workers.dev";

function metadata(
  script = "a",
  extra: Partial<PerSlugInfraMeta> = {},
): PerSlugInfraMeta {
  return {
    account_id: "account",
    account_name: "Account",
    d1_database_id: `db-${script}`,
    r2_bucket_name: `bucket-${script}`,
    infra_slug: script,
    worker_url: `https://${script}.acct.workers.dev`,
    ...extra,
  };
}
function save(slug: string, meta = metadata(slug)) {
  writeFileSync(join(home, "infra", `${slug}.toml`), stringify(meta));
}
function legacy(meta = metadata("b")) {
  writeFileSync(
    join(home, "infra.toml"),
    stringify({ ...meta, hmac_key: "do-not-print-this-secret" }),
  );
}
function repo(url = urlA, key: string | undefined = "a-id") {
  writeConfigFile(
    {
      project_id: "example",
      backend: "cloudflare",
      worker_url: url,
      schema_version: 1,
      tila_version: "0.8.0",
      created_at: "2026-10-14",
      ...(key ? { instance: { instance_key: key } } : {}),
    },
    join(root, ".tila"),
  );
}
async function registry(current: string | null = null) {
  await writeRegistry(new TilaPaths(), {
    version: 1,
    current_context: current as InstanceKey | null,
    instances: ["a", "b"].map((name) => ({
      instance_key: `${name}-id` as InstanceKey,
      worker_url: `https://${name}.acct.workers.dev`,
      instance_id_source: "client-uuid",
      trust: { trusted: true, trusted_at: 1 },
      created_at: 1,
    })),
  });
}
function resolve(
  flags: {
    infra?: string;
    instance?: string;
    project?: string;
    inlineToken?: boolean;
  } = {},
) {
  return resolveDeployTarget({ cf, store, home, ...flags });
}

beforeEach(async () => {
  vi.resetAllMocks();
  originalCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), "tila-deploy-target-"));
  home = join(root, "home");
  mkdirSync(join(home, "infra"), { recursive: true });
  process.chdir(root);
  vi.stubEnv("TILA_HOME", home);
  for (const name of [
    "TILA_INSTANCE",
    "TILA_CONFIG",
    "TILA_TOKEN",
    "TILA_API_TOKEN",
  ])
    vi.stubEnv(name, undefined);
  secretGet.mockImplementation(() => {
    throw new Error("keychain must not be accessed");
  });
  store = new AuthStore({
    paths: new TilaPaths(),
    secrets: { get: secretGet, set: vi.fn(), delete: vi.fn() },
    env: { isCI: true, isTTY: false },
  });
  subdomains.mockResolvedValue({ subdomain: "acct" });
  domains.mockReturnValue([]);
  settings.mockImplementation(async (script: string) => ({
    bindings: [
      { name: "DB", type: "d1", database_id: `db-${script}` },
      { name: "ARTIFACTS", type: "r2_bucket", bucket_name: `bucket-${script}` },
    ],
  }));
  await registry();
});
afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("deployment target selection", () => {
  it("refuses repository A when only global B exists", async () => {
    repo();
    legacy();
    await expect(resolve()).rejects.toMatchObject({
      code: "DEPLOY_TARGET_MISMATCH",
    });
    expect(settings).not.toHaveBeenCalled();
  });
  it("selects saved A instead of global B without reading credentials", async () => {
    repo();
    save("a");
    legacy();
    vi.stubEnv("CI", "true");
    vi.stubEnv("TILA_TOKEN", "irrelevant-token");
    const target = await resolve();
    expect(target).toMatchObject({
      source: "repo-pointer",
      infraSlug: "a",
      accountId: "account",
      scriptName: "a",
      d1DatabaseId: "db-a",
      r2BucketName: "bucket-a",
    });
    expect(secretGet).not.toHaveBeenCalled();
    expect(JSON.stringify(target)).not.toMatch(/secret|token/);
  });
  it.each([
    { infra: "b" },
    { instance: "b-id" },
    { infra: "b", instance: "b-id" },
  ])("explicitly selects B from repository A: %j", async (flags) => {
    repo();
    save("a");
    legacy();
    expect(await resolve(flags)).toMatchObject({
      scriptName: "b",
      d1DatabaseId: "db-b",
    });
    expect(settings).toHaveBeenCalledExactlyOnceWith("b", {
      account_id: "account",
    });
  });
  it("rejects conflicting explicit selectors", async () => {
    save("b");
    await expect(
      resolve({ infra: "b", instance: "a-id" }),
    ).rejects.toMatchObject({ code: "DEPLOY_TARGET_MISMATCH" });
  });
  it("requires selection even with a sole installation", async () => {
    save("a");
    await expect(resolve()).rejects.toMatchObject({
      code: "DEPLOY_TARGET_REQUIRED",
    });
    expect(subdomains).not.toHaveBeenCalled();
  });
  it("uses environment selection before the repository and flags before environment", async () => {
    repo();
    save("a");
    save("b");
    vi.stubEnv("TILA_INSTANCE", "b-id");
    expect(await resolve()).toMatchObject({ source: "env", scriptName: "b" });
    expect(await resolve({ instance: "a-id" })).toMatchObject({
      source: "flag",
      scriptName: "a",
    });
  });
  it("uses an explicit config before the repository", async () => {
    repo(urlB, "b-id");
    const path = join(root, ".tila", "config.toml");
    const { readFileSync } = await import("node:fs");
    const envPath = join(root, "env.toml");
    writeFileSync(envPath, readFileSync(path));
    repo();
    save("a");
    save("b");
    vi.stubEnv("TILA_CONFIG", envPath);
    expect(await resolve()).toMatchObject({ source: "env", scriptName: "b" });
  });
  it("uses the current context outside a repository", async () => {
    await registry("b-id");
    save("b");
    expect(await resolve()).toMatchObject({
      source: "current-context",
      scriptName: "b",
    });
  });
  it("supports URL-only repository pointers", async () => {
    repo(urlA, "");
    save("a");
    expect(await resolve()).toMatchObject({
      instanceKey: null,
      scriptName: "a",
    });
  });
  it("does not fall back from an invalid instance or corrupt selected config", async () => {
    save("b");
    await registry("b-id");
    await expect(resolve({ instance: "missing" })).rejects.toMatchObject({
      code: "DEPLOY_TARGET_NOT_FOUND",
    });
    vi.stubEnv("TILA_CONFIG", join(root, "missing.toml"));
    await expect(resolve()).rejects.toMatchObject({
      code: "DEPLOY_TARGET_UNVERIFIED",
    });
    expect(settings).not.toHaveBeenCalled();
  });
  it("prefers the per-slug record over the legacy file and strips secrets", async () => {
    legacy(metadata("b"));
    save("b", metadata("a"));
    const target = await resolve({ infra: "b" });
    expect(target).toMatchObject({ infraSlug: "b", scriptName: "a" });
    expect(JSON.stringify(target)).not.toContain("do-not-print");
  });
  it("uses the record slug when infra_slug is absent", async () => {
    save("a", metadata("a", { infra_slug: undefined }));
    expect(await resolve({ infra: "a" })).toMatchObject({ scriptName: "a" });
  });
  it("requires disambiguation when two records identify one Worker", async () => {
    repo();
    save("a");
    save("alias", metadata());
    await expect(resolve()).rejects.toMatchObject({
      code: "DEPLOY_TARGET_AMBIGUOUS",
    });
    expect(await resolve({ infra: "alias", instance: "a-id" })).toMatchObject({
      infraSlug: "alias",
    });
  });
  it("reports missing metadata without provisioning anything", async () => {
    await expect(resolve({ infra: "missing" })).rejects.toMatchObject({
      code: "DEPLOY_TARGET_NOT_FOUND",
    });
  });
  it("rejects path traversal in an explicit slug", async () => {
    await expect(resolve({ infra: "../a" })).rejects.toMatchObject({
      code: "DEPLOY_TARGET_UNVERIFIED",
    });
  });
});

describe("agreement with credential context", () => {
  it.each(["TILA_TOKEN", "TILA_API_TOKEN"])(
    "refuses repo A plus %s and TILA_INSTANCE=B",
    async (tokenEnv) => {
      repo();
      save("a");
      save("b");
      vi.stubEnv(tokenEnv, "never-read-or-send-this");
      vi.stubEnv("TILA_INSTANCE", "b-id");
      await expect(resolve()).rejects.toMatchObject({
        code: "DEPLOY_TARGET_MISMATCH",
      });
      expect(settings).not.toHaveBeenCalled();
      expect(secretGet).not.toHaveBeenCalled();
    },
  );
  it("accepts a matching inline-token context", async () => {
    repo();
    save("a");
    vi.stubEnv("TILA_TOKEN", "token");
    vi.stubEnv("TILA_INSTANCE", "a-id");
    expect(await resolve()).toMatchObject({ scriptName: "a" });
  });
  it("honors an explicit instance before an environment token", async () => {
    repo();
    save("b");
    vi.stubEnv("TILA_TOKEN", "token");
    expect(await resolve({ instance: "b-id" })).toMatchObject({
      scriptName: "b",
    });
  });
  it("refuses --token conflicting with --instance", async () => {
    repo();
    save("b");
    await expect(
      resolve({ instance: "b-id", inlineToken: true }),
    ).rejects.toMatchObject({ code: "DEPLOY_TARGET_MISMATCH" });
    expect(settings).not.toHaveBeenCalled();
  });
  it("allows explicit infrastructure to override ambient inline context", async () => {
    repo();
    save("b");
    vi.stubEnv("TILA_TOKEN", "token");
    vi.stubEnv("TILA_INSTANCE", "b-id");
    expect(await resolve({ infra: "b" })).toMatchObject({ scriptName: "b" });
  });
  it.each([{}, { infra: "b" }, { instance: "b-id" }])(
    "refuses a mismatched --project assertion: %j",
    async (selectors) => {
      repo();
      save("a");
      save("b");
      await expect(
        resolve({ ...selectors, project: "wrong" }),
      ).rejects.toMatchObject({ code: "DEPLOY_TARGET_MISMATCH" });
      expect(subdomains).not.toHaveBeenCalled();
      expect(settings).not.toHaveBeenCalled();
    },
  );
  it("allows a matching project assertion", async () => {
    repo();
    save("a");
    expect(await resolve({ project: "example" })).toMatchObject({
      scriptName: "a",
    });
  });
});

describe("selection failure boundaries", () => {
  it("walks up to repository configuration from a nested directory", async () => {
    repo();
    save("a");
    const nested = join(root, "src", "nested");
    mkdirSync(nested, { recursive: true });
    process.chdir(nested);
    expect(await resolve()).toMatchObject({ scriptName: "a" });
  });
  it("refuses corrupt repository metadata even with a valid current context", async () => {
    repo();
    save("a");
    await registry("a-id");
    writeFileSync(
      join(root, ".tila", "config.toml"),
      'token = "secret-value"\ninvalid [[[ toml',
    );
    await expect(resolve()).rejects.toMatchObject({
      code: "DEPLOY_TARGET_UNVERIFIED",
      message: expect.not.stringContaining("secret-value"),
    });
    expect(settings).not.toHaveBeenCalled();
  });
  it("refuses corrupt installation metadata rather than using the legacy record", async () => {
    legacy(metadata("a"));
    writeFileSync(join(home, "infra", "a.toml"), "invalid [[[ toml");
    await expect(resolve({ infra: "a" })).rejects.toMatchObject({
      code: "DEPLOY_TARGET_UNVERIFIED",
    });
    expect(settings).not.toHaveBeenCalled();
  });
  it("refuses local context unless infrastructure is explicitly selected", async () => {
    writeConfigFile(
      {
        project_id: "local",
        backend: "local",
        schema_version: 1,
        tila_version: "0.8.0",
        created_at: "2026-10-14",
      },
      join(root, ".tila"),
    );
    save("a");
    await registry("a-id");
    await expect(resolve()).rejects.toMatchObject({
      code: "DEPLOY_TARGET_NOT_FOUND",
    });
    expect(await resolve({ infra: "a" })).toMatchObject({ scriptName: "a" });
  });
  it("retains legacy Worker and bucket defaults only when live bindings match", async () => {
    legacy(
      metadata("tila", { infra_slug: undefined, r2_bucket_name: undefined }),
    );
    settings.mockResolvedValue({
      bindings: [
        { name: "DB", type: "d1", database_id: "db-tila" },
        { name: "ARTIFACTS", type: "r2_bucket", bucket_name: "tila-artifacts" },
      ],
    });
    expect(await resolve({ infra: "tila" })).toMatchObject({
      scriptName: "tila",
      r2BucketName: "tila-artifacts",
    });
  });
  it("normalizes display URLs without exposing query parameters", async () => {
    repo("https://A.acct.workers.dev/?token=secret#secret");
    save("a");
    expect(await resolve()).toMatchObject({ workerUrl: urlA });
  });
});

describe("Cloudflare identity and binding verification", () => {
  it("accepts a custom-domain alias of the registered Worker", async () => {
    repo("https://tila.example.com");
    save("a");
    domains.mockReturnValue([
      { hostname: "tila.example.com", service: "a", environment: "production" },
    ]);
    expect(await resolve()).toMatchObject({
      scriptName: "a",
      workerUrl: "https://tila.example.com",
    });
  });
  it("rejects a stored URL that belongs to another Worker even when strings agree", async () => {
    repo();
    save("b", metadata("b", { worker_url: urlA }));
    await expect(resolve({ infra: "b" })).rejects.toMatchObject({
      code: "DEPLOY_TARGET_MISMATCH",
    });
    expect(settings).not.toHaveBeenCalled();
  });
  it("rejects a repository URL claiming another registered instance", async () => {
    repo(urlB, "a-id");
    save("b");
    await expect(resolve()).rejects.toMatchObject({
      code: "DEPLOY_TARGET_MISMATCH",
    });
  });
  it("distinguishes the same Worker name in different accounts", async () => {
    repo();
    save("a");
    save(
      "other",
      metadata("a", {
        account_id: "other",
        worker_url: "https://a.other.workers.dev",
      }),
    );
    subdomains.mockImplementation(
      async ({ account_id }: { account_id: string }) => ({
        subdomain: account_id === "account" ? "acct" : "other",
      }),
    );
    expect(await resolve()).toMatchObject({ accountId: "account" });
  });
  it.each([
    [
      { name: "DB", type: "d1", database_id: "wrong" },
      { name: "ARTIFACTS", type: "r2_bucket", bucket_name: "bucket-a" },
    ],
    [
      { name: "DB", type: "d1", database_id: "db-a" },
      { name: "ARTIFACTS", type: "r2_bucket", bucket_name: "wrong" },
    ],
    [],
  ])("rejects incorrect or missing bindings (%j)", async (...bindings) => {
    save("a");
    settings.mockResolvedValue({ bindings });
    await expect(resolve({ infra: "a" })).rejects.toMatchObject({
      code: "DEPLOY_TARGET_MISMATCH",
    });
  });
  it("supports legacy D1 binding IDs", async () => {
    save("a");
    settings.mockResolvedValue({
      bindings: [
        { name: "DB", type: "d1", id: "db-a" },
        { name: "ARTIFACTS", type: "r2_bucket", bucket_name: "bucket-a" },
      ],
    });
    expect(await resolve({ infra: "a" })).toMatchObject({
      d1DatabaseId: "db-a",
    });
  });
  it.each([
    "https://proxy.example.com",
    "https://a.acct.workers.dev/path",
    "https://a.acct.workers.dev:8443",
    "https://preview-a.acct.workers.dev",
  ])("refuses unverifiable routing: %s", async (url) => {
    repo(url, "");
    save("a");
    await expect(resolve()).rejects.toMatchObject({
      code: expect.stringMatching(/^DEPLOY_TARGET_(MISMATCH|UNVERIFIED)$/),
    });
    expect(settings).not.toHaveBeenCalled();
  });
  it("sanitizes Cloudflare failures and never treats them as absence", async () => {
    repo();
    save("a");
    subdomains.mockRejectedValue(
      new Error("Authorization: super-secret-token"),
    );
    await expect(resolve()).rejects.toMatchObject({
      code: "DEPLOY_TARGET_UNVERIFIED",
      message: expect.not.stringContaining("super-secret"),
    });
    expect(settings).not.toHaveBeenCalled();
  });
  it("refuses inaccessible or missing Workers", async () => {
    save("a");
    settings.mockRejectedValue(new Error("404"));
    await expect(resolve({ infra: "a" })).rejects.toMatchObject({
      code: "DEPLOY_TARGET_UNVERIFIED",
    });
  });
});
