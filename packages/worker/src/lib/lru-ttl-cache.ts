/**
 * Generic LRU cache with separate positive and negative TTLs.
 *
 * Uses Map insertion order for O(1) LRU tracking: delete + re-insert on
 * access promotes an entry to most-recently-used. The oldest entry (first
 * in iteration order) is evicted when the cache exceeds maxSize.
 *
 * Negative entries (e.g. "known invalid") can carry a shorter TTL via
 * the `negative` flag on `set()`.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export interface LruTtlCacheOptions {
  maxSize: number;
  positiveTtlMs: number;
  negativeTtlMs: number;
}

export class LruTtlCache<T> {
  private readonly map = new Map<string, Entry<T>>();
  private readonly maxSize: number;
  private readonly positiveTtlMs: number;
  private readonly negativeTtlMs: number;

  constructor(options: LruTtlCacheOptions) {
    this.maxSize = options.maxSize;
    this.positiveTtlMs = options.positiveTtlMs;
    this.negativeTtlMs = options.negativeTtlMs;
  }

  /**
   * Retrieve a value by key.
   * Returns `undefined` on miss or if the entry has expired (and removes it).
   * On a live hit, promotes the entry to most-recently-used.
   */
  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }

    // LRU promotion: delete + re-insert moves the key to the end of Map order
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  /**
   * Store a value.
   * Pass `negative: true` to use the shorter negativeTtlMs instead of positiveTtlMs.
   * If the key already exists it is updated in-place (size does not change).
   * If the cache is at capacity, the oldest entry (LRU) is evicted first.
   */
  set(key: string, value: T, negative = false): void {
    if (this.map.has(key)) {
      // Update existing: delete first to move to end of insertion order
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Evict the oldest (first) entry
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
      }
    }

    const ttl = negative ? this.negativeTtlMs : this.positiveTtlMs;
    this.map.set(key, { value, expiresAt: Date.now() + ttl });
  }

  /** Remove an entry. No-op if the key does not exist. */
  delete(key: string): void {
    this.map.delete(key);
  }

  /** Remove all entries. */
  clear(): void {
    this.map.clear();
  }

  /** Current number of entries (including entries that may be expired but not yet evicted). */
  get size(): number {
    return this.map.size;
  }
}
