import { describe, expect, it } from "vitest";
import { adminCacheKey } from "./admin-cache-key";

// Cross-site host parity (the revoke purge keying the same string the lookup stored)
// is covered by admin-roster.test.ts revoke-then-deny integration test, not this unit test.

describe("adminCacheKey", () => {
  it("produces the byte-identical format projectId:host:userId", () => {
    expect(
      adminCacheKey({ host: "github.com", projectId: "p1", userId: "u1" }),
    ).toBe("p1:github.com:u1");
  });

  it("honours a different host in the middle segment", () => {
    expect(
      adminCacheKey({ host: "ghe.example.com", projectId: "p1", userId: "u1" }),
    ).toBe("p1:ghe.example.com:u1");
  });

  it("field ordering is projectId:host:userId", () => {
    expect(adminCacheKey({ host: "h", projectId: "p", userId: "u" })).toBe(
      "p:h:u",
    );
  });
});
