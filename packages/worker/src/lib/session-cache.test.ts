import type { SessionResult } from "@tila/backend-d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _clearSessionCacheForTest,
  _sessionCacheSizeForTest,
  getSessionFromCache,
  invalidateSession,
  setSessionInCache,
} from "./session-cache";

const makeSessionResult = (
  overrides?: Partial<SessionResult>,
): SessionResult => ({
  projectId: "proj-1",
  tokenHash: "tok-hash-abc",
  name: "testuser",
  scopes: "full",
  expiresAt: Date.now() + 3_600_000, // 1 hour
  ...overrides,
});

beforeEach(() => {
  _clearSessionCacheForTest();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getSessionFromCache", () => {
  it("returns undefined on cache miss", () => {
    expect(getSessionFromCache("unknown-hash")).toBeUndefined();
  });

  it("returns undefined for empty string hash", () => {
    expect(getSessionFromCache("")).toBeUndefined();
  });

  it("returns SessionResult on positive cache hit", () => {
    const result = makeSessionResult();
    setSessionInCache("hash-a", result);
    expect(getSessionFromCache("hash-a")).toEqual(result);
  });

  it("returns false on negative cache hit", () => {
    setSessionInCache("hash-b", false);
    expect(getSessionFromCache("hash-b")).toBe(false);
  });

  it("expires positive entries after 60s", () => {
    setSessionInCache("hash-c", makeSessionResult());
    vi.advanceTimersByTime(60_001);
    expect(getSessionFromCache("hash-c")).toBeUndefined();
  });

  it("expires negative entries after 10s", () => {
    setSessionInCache("hash-d", false);
    vi.advanceTimersByTime(10_001);
    expect(getSessionFromCache("hash-d")).toBeUndefined();
  });

  it("returns hit within TTL window", () => {
    const result = makeSessionResult();
    setSessionInCache("hash-e", result);
    vi.advanceTimersByTime(59_999);
    expect(getSessionFromCache("hash-e")).toEqual(result);
  });
});

describe("invalidateSession", () => {
  it("removes a cached entry", () => {
    setSessionInCache("hash-f", makeSessionResult());
    invalidateSession("hash-f");
    expect(getSessionFromCache("hash-f")).toBeUndefined();
  });

  it("is a no-op for unknown hashes", () => {
    invalidateSession("nonexistent"); // should not throw
  });
});

describe("LRU eviction", () => {
  it("evicts oldest entry when cache exceeds MAX_CACHE_SIZE (500)", () => {
    for (let i = 0; i < 500; i++) {
      setSessionInCache(`hash-${i}`, makeSessionResult());
    }
    expect(_sessionCacheSizeForTest()).toBe(500);

    // Add one more -- should evict hash-0 (oldest)
    setSessionInCache("hash-500", makeSessionResult());
    expect(_sessionCacheSizeForTest()).toBe(500);
    expect(getSessionFromCache("hash-0")).toBeUndefined(); // evicted
    const hit = getSessionFromCache("hash-500");
    expect(hit).not.toBeUndefined();
    expect(hit).not.toBe(false);
  });

  it("does not evict when updating an existing key", () => {
    for (let i = 0; i < 500; i++) {
      setSessionInCache(`hash-${i}`, makeSessionResult());
    }

    // Re-set an existing key -- should not trigger eviction
    setSessionInCache("hash-250", false);
    expect(_sessionCacheSizeForTest()).toBe(500);
    expect(getSessionFromCache("hash-0")).not.toBeUndefined(); // still present
    expect(getSessionFromCache("hash-250")).toBe(false); // updated to negative
  });

  it("promotes accessed entries so they are not evicted first", () => {
    for (let i = 0; i < 500; i++) {
      setSessionInCache(`hash-${i}`, makeSessionResult());
    }

    // Access hash-0 to promote it to most-recently-used
    getSessionFromCache("hash-0");

    // Add a new entry -- should evict hash-1 (now the oldest)
    setSessionInCache("hash-new", makeSessionResult());
    expect(_sessionCacheSizeForTest()).toBe(500);
    expect(getSessionFromCache("hash-0")).not.toBeUndefined(); // promoted, still present
    expect(getSessionFromCache("hash-1")).toBeUndefined(); // evicted
  });
});
