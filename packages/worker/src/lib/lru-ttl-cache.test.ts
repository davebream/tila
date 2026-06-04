import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LruTtlCache } from "./lru-ttl-cache";

const POSITIVE_TTL = 60_000;
const NEGATIVE_TTL = 10_000;
const MAX_SIZE = 5;

function makeCache<T = string>() {
  return new LruTtlCache<T>({
    maxSize: MAX_SIZE,
    positiveTtlMs: POSITIVE_TTL,
    negativeTtlMs: NEGATIVE_TTL,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("get / set basics", () => {
  it("returns undefined on cache miss", () => {
    const cache = makeCache();
    expect(cache.get("missing")).toBeUndefined();
  });

  it("returns value on hit", () => {
    const cache = makeCache();
    cache.set("k", "v");
    expect(cache.get("k")).toBe("v");
  });

  it("increases size on new insert", () => {
    const cache = makeCache();
    cache.set("a", "1");
    cache.set("b", "2");
    expect(cache.size).toBe(2);
  });

  it("does not increase size when updating existing key", () => {
    const cache = makeCache();
    cache.set("k", "v1");
    cache.set("k", "v2");
    expect(cache.size).toBe(1);
    expect(cache.get("k")).toBe("v2");
  });
});

describe("TTL expiry", () => {
  it("returns value within positive TTL window", () => {
    const cache = makeCache();
    cache.set("k", "v");
    vi.advanceTimersByTime(POSITIVE_TTL - 1);
    expect(cache.get("k")).toBe("v");
  });

  it("returns undefined after positive TTL expires", () => {
    const cache = makeCache();
    cache.set("k", "v");
    vi.advanceTimersByTime(POSITIVE_TTL + 1);
    expect(cache.get("k")).toBeUndefined();
  });

  it("decreases size when expired entry is accessed", () => {
    const cache = makeCache();
    cache.set("k", "v");
    expect(cache.size).toBe(1);
    vi.advanceTimersByTime(POSITIVE_TTL + 1);
    cache.get("k"); // triggers removal
    expect(cache.size).toBe(0);
  });

  it("returns value within negative TTL window", () => {
    const cache = makeCache();
    cache.set("k", "v", true);
    vi.advanceTimersByTime(NEGATIVE_TTL - 1);
    expect(cache.get("k")).toBe("v");
  });

  it("returns undefined after negative TTL expires", () => {
    const cache = makeCache();
    cache.set("k", "v", true);
    vi.advanceTimersByTime(NEGATIVE_TTL + 1);
    expect(cache.get("k")).toBeUndefined();
  });

  it("negative TTL is shorter than positive TTL", () => {
    const cache = makeCache();
    cache.set("pos", "positive");
    cache.set("neg", "negative", true);

    vi.advanceTimersByTime(NEGATIVE_TTL + 1); // past negative, still within positive
    expect(cache.get("neg")).toBeUndefined();
    expect(cache.get("pos")).toBe("positive");
  });
});

describe("LRU eviction", () => {
  it("evicts oldest entry when maxSize is exceeded", () => {
    const cache = makeCache();
    for (let i = 0; i < MAX_SIZE; i++) {
      cache.set(`k${i}`, `v${i}`);
    }
    expect(cache.size).toBe(MAX_SIZE);

    cache.set("new", "vNew");
    expect(cache.size).toBe(MAX_SIZE);
    expect(cache.get("k0")).toBeUndefined(); // evicted (oldest)
    expect(cache.get("new")).toBe("vNew");
  });

  it("does not evict when updating an existing key", () => {
    const cache = makeCache();
    for (let i = 0; i < MAX_SIZE; i++) {
      cache.set(`k${i}`, `v${i}`);
    }

    cache.set("k0", "updated"); // update, not new
    expect(cache.size).toBe(MAX_SIZE);
    expect(cache.get("k1")).toBe("v1"); // k1 was not evicted
    expect(cache.get("k0")).toBe("updated");
  });

  it("promotes accessed entry so it is not evicted first", () => {
    const cache = makeCache();
    for (let i = 0; i < MAX_SIZE; i++) {
      cache.set(`k${i}`, `v${i}`);
    }

    // Access k0 to promote it (k1 becomes the oldest)
    cache.get("k0");

    cache.set("new", "vNew"); // should evict k1, not k0
    expect(cache.size).toBe(MAX_SIZE);
    expect(cache.get("k0")).toBe("v0"); // still present (promoted)
    expect(cache.get("k1")).toBeUndefined(); // evicted (became oldest after k0 promoted)
  });

  it("maintains size invariant after many inserts beyond capacity", () => {
    const cache = makeCache();
    for (let i = 0; i < MAX_SIZE * 3; i++) {
      cache.set(`k${i}`, `v${i}`);
    }
    expect(cache.size).toBe(MAX_SIZE);
  });
});

describe("delete", () => {
  it("removes an existing entry", () => {
    const cache = makeCache();
    cache.set("k", "v");
    cache.delete("k");
    expect(cache.get("k")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("is a no-op for a non-existent key", () => {
    const cache = makeCache();
    expect(() => cache.delete("nonexistent")).not.toThrow();
    expect(cache.size).toBe(0);
  });
});

describe("clear", () => {
  it("resets size to 0", () => {
    const cache = makeCache();
    cache.set("a", "1");
    cache.set("b", "2");
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("returns undefined for all keys after clear", () => {
    const cache = makeCache();
    cache.set("a", "1");
    cache.clear();
    expect(cache.get("a")).toBeUndefined();
  });
});
