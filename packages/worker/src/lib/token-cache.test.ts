import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type TokenClaims,
  _cacheSizeForTest,
  _clearCacheForTest,
  getFromCache,
  invalidate,
  setInCache,
} from "./token-cache";

const CLAIMS: TokenClaims = {
  projectId: "proj-1",
  name: "test-token",
  scopes: "full",
  tokenId: "cache-test-token-id",
};

beforeEach(() => {
  _clearCacheForTest();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getFromCache", () => {
  it("returns undefined on cache miss", () => {
    expect(getFromCache("unknown-hash")).toBeUndefined();
  });

  it("returns undefined for empty string hash", () => {
    expect(getFromCache("")).toBeUndefined();
  });

  it("returns TokenClaims on positive cache hit", () => {
    setInCache("hash-a", CLAIMS);
    expect(getFromCache("hash-a")).toEqual(CLAIMS);
  });

  it("returns null on negative cache hit", () => {
    setInCache("hash-b", null);
    expect(getFromCache("hash-b")).toBeNull();
  });

  it("expires positive entries after 60s", () => {
    setInCache("hash-c", CLAIMS);
    vi.advanceTimersByTime(60_001);
    expect(getFromCache("hash-c")).toBeUndefined();
  });

  it("expires negative entries after 10s", () => {
    setInCache("hash-d", null);
    vi.advanceTimersByTime(10_001);
    expect(getFromCache("hash-d")).toBeUndefined();
  });

  it("returns hit within TTL window", () => {
    setInCache("hash-e", CLAIMS);
    vi.advanceTimersByTime(59_999);
    expect(getFromCache("hash-e")).toEqual(CLAIMS);
  });
});

describe("invalidate", () => {
  it("removes a cached entry", () => {
    setInCache("hash-f", CLAIMS);
    invalidate("hash-f");
    expect(getFromCache("hash-f")).toBeUndefined();
  });

  it("is a no-op for unknown hashes", () => {
    invalidate("nonexistent"); // should not throw
  });
});

describe("LRU eviction", () => {
  it("evicts oldest entry when cache exceeds MAX_CACHE_SIZE", () => {
    // Fill cache to capacity (1000 entries)
    for (let i = 0; i < 1000; i++) {
      setInCache(`hash-${i}`, CLAIMS);
    }
    expect(_cacheSizeForTest()).toBe(1000);

    // Add one more -- should evict hash-0 (oldest)
    setInCache("hash-1000", CLAIMS);
    expect(_cacheSizeForTest()).toBe(1000);
    expect(getFromCache("hash-0")).toBeUndefined(); // evicted
    expect(getFromCache("hash-1000")).toEqual(CLAIMS); // present
  });

  it("does not evict when updating an existing key", () => {
    for (let i = 0; i < 1000; i++) {
      setInCache(`hash-${i}`, CLAIMS);
    }

    // Re-set an existing key -- should not trigger eviction
    setInCache("hash-500", { ...CLAIMS, name: "updated" });
    expect(_cacheSizeForTest()).toBe(1000);
    expect(getFromCache("hash-0")).toEqual(CLAIMS); // still present
    expect(getFromCache("hash-500")).toEqual({ ...CLAIMS, name: "updated" });
  });

  it("promotes accessed entries so they are not evicted first", () => {
    for (let i = 0; i < 1000; i++) {
      setInCache(`hash-${i}`, CLAIMS);
    }

    // Access hash-0 to promote it to most-recently-used
    getFromCache("hash-0");

    // Add a new entry -- should evict hash-1 (now the oldest)
    setInCache("hash-new", CLAIMS);
    expect(_cacheSizeForTest()).toBe(1000);
    expect(getFromCache("hash-0")).toEqual(CLAIMS); // promoted, still present
    expect(getFromCache("hash-1")).toBeUndefined(); // evicted (was oldest after promotion)
  });

  it("maintains size invariant after many inserts beyond capacity", () => {
    for (let i = 0; i < 1500; i++) {
      setInCache(`hash-${i}`, CLAIMS);
    }
    expect(_cacheSizeForTest()).toBe(1000);
    // Only the last 1000 entries should be present
    expect(getFromCache("hash-499")).toBeUndefined();
    expect(getFromCache("hash-500")).toEqual(CLAIMS);
    expect(getFromCache("hash-1499")).toEqual(CLAIMS);
  });
});
