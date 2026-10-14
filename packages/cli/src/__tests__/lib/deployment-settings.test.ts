import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Cloudflare from "cloudflare";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DeploymentSettingsError,
  readWorkerSettings,
  resolveDeploymentSettings,
} from "../../lib/deployment-settings";
import { generateWranglerConfig } from "../../lib/wrangler-config";

let root: string;
vi.mock("../../lib/provisioning", () => ({
  resolveWorkerMainPath: () => join(root, "worker", "index.js"),
  resolveUiDistDir: () => join(root, "ui", "dist"),
}));

const getSettings = vi.fn();
const getExposure = vi.fn();
const getSubdomain = vi.fn();
const listDomains = vi.fn();
const cf = {
  workers: {
    scripts: {
      scriptAndVersionSettings: { get: getSettings },
      subdomain: { get: getExposure },
    },
    subdomains: { get: getSubdomain },
    domains: { list: listDomains },
  },
} as unknown as Cloudflare;

const analytics = {
  name: "ANALYTICS",
  type: "analytics_engine",
  dataset: "example-analytics-dataset",
} as const;
const worker = { bindings: [analytics] };
const options = { cf, accountId: "account", scriptName: "tila", worker };
const domain = {
  service: "tila",
  environment: "production",
  hostname: "tila.example.com",
};

beforeEach(() => {
  vi.resetAllMocks();
  root = mkdtempSync(join(tmpdir(), "tila-settings-"));
  mkdirSync(join(root, "worker"));
  getSettings.mockResolvedValue(worker);
  getExposure.mockResolvedValue({ enabled: false, previews_enabled: false });
  getSubdomain.mockResolvedValue({ subdomain: "account" });
  listDomains.mockReturnValue([domain]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("deployment settings preservation", () => {
  it.each([undefined, 123, "tila.example.com/path", "tila.example.com "])(
    "refuses malformed custom-domain hostnames: %j",
    async (hostname) => {
      listDomains.mockReturnValue([{ ...domain, hostname }]);
      await expect(resolveDeploymentSettings(options)).rejects.toThrow(
        "Could not verify",
      );
    },
  );

  it.each([undefined, 123, "account/other", ""])(
    "refuses malformed account subdomains: %j",
    async (subdomain) => {
      getSubdomain.mockResolvedValue({ subdomain });
      await expect(
        resolveDeploymentSettings({ ...options, worker: null }),
      ).rejects.toThrow("Could not verify");
    },
  );

  it.each([false, true])(
    "carries live settings into generated TOML (skipAssets=%s)",
    async (skipAssets) => {
      getSettings.mockResolvedValue({
        bindings: [
          analytics,
          {
            name: "EXTRA",
            type: "analytics_engine",
            dataset: "another_dataset",
          },
          { name: "SECRET", type: "secret_text", text: "must-not-be-copied" },
        ],
      });
      const observed = await readWorkerSettings(cf, "account", "tila");
      const deployment = await resolveDeploymentSettings({
        ...options,
        worker: observed,
        preferredUrl: "https://tila.example.com",
      });
      const file = generateWranglerConfig({
        slug: "tila",
        accountId: "account",
        databaseId: "db",
        settings: deployment.settings,
        skipAssets,
      });
      const text = readFileSync(file, "utf8");
      const config = parse(text);
      expect(config.workers_dev).toBe(false);
      expect(config.preview_urls).toBe(false);
      expect(config.analytics_engine_datasets).toEqual([
        { binding: "ANALYTICS", dataset: "example-analytics-dataset" },
        { binding: "EXTRA", dataset: "another_dataset" },
      ]);
      expect(config).not.toHaveProperty("route");
      expect(config).not.toHaveProperty("routes");
      expect(Boolean(config.assets)).toBe(!skipAssets);
      expect(text).not.toContain("must-not-be-copied");
      expect(deployment.workerUrl).toBe("https://tila.example.com");
    },
  );

  it.each([
    { enabled: true, previews_enabled: false },
    { enabled: false, previews_enabled: true },
    { enabled: true, previews_enabled: true },
  ])("preserves independent exposure switches: %j", async (exposure) => {
    getExposure.mockResolvedValue(exposure);
    const result = await resolveDeploymentSettings(options);
    expect(result.settings).toMatchObject({
      workersDev: exposure.enabled,
      previewUrls: exposure.previews_enabled,
    });
  });

  it.each([
    {},
    { enabled: false },
    { enabled: "false", previews_enabled: false },
    null,
  ])("rejects incomplete exposure: %j", async (exposure) => {
    getExposure.mockResolvedValue(exposure);
    await expect(resolveDeploymentSettings(options)).rejects.toBeInstanceOf(
      DeploymentSettingsError,
    );
  });

  it.each(
    [
      [],
      [analytics, analytics],
      [{ ...analytics, type: "plain_text" }],
      [{ ...analytics, dataset: "" }],
      [{ ...analytics, dataset: null }],
      [{ ...analytics, dataset: " padded " }],
      [analytics, { ...analytics, name: "EXTRA", dataset: "" }],
      [
        analytics,
        { ...analytics, name: "EXTRA" },
        { ...analytics, name: "EXTRA" },
      ],
    ].map((bindings) => ({ bindings })),
  )("refuses invalid analytics bindings: %j", async ({ bindings }) => {
    await expect(
      resolveDeploymentSettings({
        ...options,
        worker: { bindings } as unknown as typeof worker,
      }),
    ).rejects.toBeInstanceOf(DeploymentSettingsError);
  });

  it("prefers a verified custom domain even with workers.dev enabled", async () => {
    getExposure.mockResolvedValue({ enabled: true, previews_enabled: true });
    const result = await resolveDeploymentSettings({
      ...options,
      preferredUrl: "https://tila.example.com/",
    });
    expect(result.workerUrl).toBe("https://tila.example.com");
    expect(getSubdomain).not.toHaveBeenCalled();
  });

  it("replaces a disabled workers.dev URL with the unique custom domain", async () => {
    const result = await resolveDeploymentSettings({
      ...options,
      preferredUrl: "https://tila.account.workers.dev",
    });
    expect(result.workerUrl).toBe("https://tila.example.com");
  });

  it.each(
    [
      [],
      [domain, { ...domain, hostname: "other.example.com" }],
      [{ ...domain, service: "other" }],
      [{ ...domain, environment: "staging" }],
    ].map((domains) => ({ domains })),
  )("refuses unresolved endpoints: %j", async ({ domains }) => {
    listDomains.mockReturnValue(domains);
    await expect(resolveDeploymentSettings(options)).rejects.toThrow(
      "no unambiguous",
    );
  });

  it("allows multiple custom domains when the selected URL identifies one", async () => {
    listDomains.mockReturnValue([
      domain,
      { ...domain, hostname: "other.example.com" },
    ]);
    expect(
      (
        await resolveDeploymentSettings({
          ...options,
          preferredUrl: "https://other.example.com",
        })
      ).workerUrl,
    ).toBe("https://other.example.com");
  });

  it("uses the account-qualified workers.dev URL when enabled", async () => {
    getExposure.mockResolvedValue({ enabled: true, previews_enabled: false });
    expect((await resolveDeploymentSettings(options)).workerUrl).toBe(
      "https://tila.account.workers.dev",
    );
  });

  it.each([getSettings, getExposure, listDomains, getSubdomain])(
    "sanitizes failed Cloudflare reads",
    async (read) => {
      getExposure.mockResolvedValue({ enabled: true, previews_enabled: false });
      read.mockImplementation(() => {
        throw new Error("private-token-in-provider-error");
      });
      const action =
        read === getSettings
          ? readWorkerSettings(cf, "account", "tila", true)
          : resolveDeploymentSettings({
              ...options,
              preferredUrl:
                read === getSubdomain ? null : "https://tila.example.com",
            });
      await expect(action).rejects.toThrow("Could not verify");
      await expect(action).rejects.not.toThrow("private-token");
    },
  );

  it("uses defaults only after a script-specific not-found response", async () => {
    getSettings.mockRejectedValue(
      new Cloudflare.NotFoundError(
        404,
        { errors: [{ code: 10007, message: "Worker not found" }] },
        "not found",
        new Headers(),
      ),
    );
    const absent = await readWorkerSettings(cf, "account", "tila", true);
    expect(absent).toBeNull();
    const result = await resolveDeploymentSettings({
      ...options,
      worker: absent,
    });
    expect(result.settings).toEqual({
      workersDev: true,
      analyticsEngineDatasets: [
        { binding: "ANALYTICS", dataset: "tila-analytics" },
      ],
    });
    expect(getExposure).not.toHaveBeenCalled();
    await expect(readWorkerSettings(cf, "account", "tila")).rejects.toThrow(
      "Could not verify",
    );
  });

  it.each([403, 404, 500])(
    "does not treat an unrelated HTTP %s error as absence",
    async (status) => {
      getSettings.mockRejectedValue(
        Cloudflare.APIError.generate(
          status,
          { errors: [{ code: 9999, message: "private" }] },
          "private",
          new Headers(),
        ),
      );
      await expect(
        readWorkerSettings(cf, "account", "tila", true),
      ).rejects.toThrow("Could not verify");
    },
  );

  it.each([null, undefined, {}])(
    "does not treat malformed settings as absence: %j",
    async (value) => {
      getSettings.mockResolvedValue(value);
      await expect(
        readWorkerSettings(cf, "account", "tila", true),
      ).rejects.toThrow("Could not verify");
    },
  );
});
