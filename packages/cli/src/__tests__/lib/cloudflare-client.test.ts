import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the cloudflare module before importing our code
vi.mock("cloudflare", () => {
  const MockCloudflare = vi.fn().mockImplementation(
    class {
      accounts = { list: vi.fn() };
    } as unknown as () => unknown,
  );
  return { default: MockCloudflare };
});

import Cloudflare from "cloudflare";

const MockCloudflare = vi.mocked(Cloudflare);

describe("createCloudflareClient", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    MockCloudflare.mockImplementation(
      class {
        accounts = { list: vi.fn() };
      } as unknown as typeof Cloudflare,
    );
  });

  it("returns a Cloudflare instance", async () => {
    const { createCloudflareClient } = await import(
      "../../lib/cloudflare-client"
    );
    const client = createCloudflareClient("test-api-token");

    expect(client).toBeDefined();
    expect(client.accounts).toBeDefined();
    expect(client.accounts.list).toBeDefined();
    expect(MockCloudflare).toHaveBeenCalledWith({
      apiToken: "test-api-token",
      timeout: 15_000,
      maxRetries: 1,
    });
  });
});

describe("resolveAccountId", () => {
  let savedAccountId: string | undefined;
  let savedApiToken: string | undefined;
  const dummyClient = {} as Cloudflare;

  function mockFetchAccounts(
    accounts: Array<{ id: string; name: string }>,
    status = 200,
  ) {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ result: accounts }),
      text: async () => JSON.stringify({ result: accounts }),
    } as Response);
  }

  beforeEach(() => {
    vi.resetAllMocks();
    savedAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    savedApiToken = process.env.CLOUDFLARE_API_TOKEN;
    Reflect.deleteProperty(process.env, "CLOUDFLARE_ACCOUNT_ID");
    Reflect.deleteProperty(process.env, "CLOUDFLARE_API_TOKEN");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedAccountId !== undefined) {
      process.env.CLOUDFLARE_ACCOUNT_ID = savedAccountId;
    } else {
      Reflect.deleteProperty(process.env, "CLOUDFLARE_ACCOUNT_ID");
    }
    if (savedApiToken !== undefined) {
      process.env.CLOUDFLARE_API_TOKEN = savedApiToken;
    } else {
      Reflect.deleteProperty(process.env, "CLOUDFLARE_API_TOKEN");
    }
  });

  it("returns first account from list", async () => {
    mockFetchAccounts([
      { id: "acct-1", name: "First Account" },
      { id: "acct-2", name: "Second Account" },
    ]);

    const { resolveAccountId } = await import("../../lib/cloudflare-client");
    const result = await resolveAccountId(dummyClient, undefined, "test-token");

    expect(result).toEqual({
      accountId: "acct-1",
      accountName: "First Account",
    });
  });

  it("with expectedId, picks matching account", async () => {
    mockFetchAccounts([
      { id: "acct-1", name: "First Account" },
      { id: "acct-2", name: "Second Account" },
    ]);

    const { resolveAccountId } = await import("../../lib/cloudflare-client");
    const result = await resolveAccountId(dummyClient, "acct-2", "test-token");

    expect(result).toEqual({
      accountId: "acct-2",
      accountName: "Second Account",
    });
  });

  it("with CLOUDFLARE_ACCOUNT_ID env var, picks matching account", async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = "acct-2";
    mockFetchAccounts([
      { id: "acct-1", name: "First Account" },
      { id: "acct-2", name: "Second Account" },
    ]);

    const { resolveAccountId } = await import("../../lib/cloudflare-client");
    const result = await resolveAccountId(dummyClient, undefined, "test-token");

    expect(result).toEqual({
      accountId: "acct-2",
      accountName: "Second Account",
    });
  });

  it("throws when no accounts returned", async () => {
    mockFetchAccounts([]);

    const { resolveAccountId } = await import("../../lib/cloudflare-client");

    await expect(
      resolveAccountId(dummyClient, undefined, "test-token"),
    ).rejects.toThrow(/No Cloudflare accounts found/);
  });

  it("with expectedId that doesn't match, throws with available accounts listed", async () => {
    mockFetchAccounts([
      { id: "acct-1", name: "First Account" },
      { id: "acct-2", name: "Second Account" },
    ]);

    const { resolveAccountId } = await import("../../lib/cloudflare-client");

    await expect(
      resolveAccountId(dummyClient, "nonexistent", "test-token"),
    ).rejects.toThrow(/Cloudflare account nonexistent not found/);
  });

  it("throws on HTTP error with body", async () => {
    mockFetchAccounts([], 401);

    const { resolveAccountId } = await import("../../lib/cloudflare-client");

    await expect(
      resolveAccountId(dummyClient, undefined, "bad-token"),
    ).rejects.toThrow(/Cloudflare API token rejected \(HTTP 401\)/);
  });

  it("throws when no token is available", async () => {
    const { resolveAccountId } = await import("../../lib/cloudflare-client");

    await expect(resolveAccountId(dummyClient)).rejects.toThrow(
      /No Cloudflare API token available/,
    );
  });

  it("network error propagates", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Network timeout"),
    );

    const { resolveAccountId } = await import("../../lib/cloudflare-client");

    await expect(
      resolveAccountId(dummyClient, undefined, "test-token"),
    ).rejects.toThrow("Network timeout");
  });
});
