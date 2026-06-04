import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkAccountMatch } from "../../lib/wrangler";

// Mock the cloudflare-client module used by verifyCloudflareAuth
const mockCreateCloudflareClient = vi.fn();
const mockResolveAccountId = vi.fn();
vi.mock("../../lib/cloudflare-client", () => ({
  createCloudflareClient: (...args: unknown[]) =>
    mockCreateCloudflareClient(...args),
  resolveAccountId: (...args: unknown[]) => mockResolveAccountId(...args),
}));

describe("wrangler helpers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("verifyCloudflareAuth", () => {
    it("returns account info from SDK", async () => {
      const fakeClient = { accounts: { list: vi.fn() } };
      mockCreateCloudflareClient.mockReturnValue(fakeClient);
      mockResolveAccountId.mockResolvedValue({
        accountId: "abc123",
        accountName: "My Account",
      });

      const { verifyCloudflareAuth } = await import("../../lib/wrangler");
      const result = await verifyCloudflareAuth("test-api-token");

      expect(mockCreateCloudflareClient).toHaveBeenCalledWith("test-api-token");
      expect(mockResolveAccountId).toHaveBeenCalledWith(
        fakeClient,
        undefined,
        "test-api-token",
      );
      expect(result).toEqual({
        account_id: "abc123",
        account_name: "My Account",
      });
    });

    it("propagates error when no accounts found", async () => {
      mockCreateCloudflareClient.mockReturnValue({});
      mockResolveAccountId.mockRejectedValue(
        new Error("No Cloudflare accounts found for this API token."),
      );

      const { verifyCloudflareAuth } = await import("../../lib/wrangler");
      await expect(verifyCloudflareAuth("bad-token")).rejects.toThrow(
        /no cloudflare accounts found/i,
      );
    });
  });

  describe("checkAccountMatch", () => {
    it("does nothing when account IDs match", () => {
      // Should not throw
      checkAccountMatch("abc123", {
        account_id: "abc123",
        account_name: "My Account",
      });
    });

    it("throws when account IDs differ", () => {
      expect(() =>
        checkAccountMatch("abc123", {
          account_id: "xyz789",
          account_name: "Other Account",
        }),
      ).toThrow(/account mismatch/i);
    });

    it("includes both account IDs in error message", () => {
      try {
        checkAccountMatch("abc123", {
          account_id: "xyz789",
          account_name: "Other Account",
        });
        expect.fail("should have thrown");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain("abc123");
        expect(msg).toContain("xyz789");
      }
    });

    it("includes updated remediation message", () => {
      try {
        checkAccountMatch("abc123", {
          account_id: "xyz789",
          account_name: "Other Account",
        });
        expect.fail("should have thrown");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain("CLOUDFLARE_API_TOKEN");
        expect(msg).not.toContain("wrangler login");
      }
    });
  });
});
