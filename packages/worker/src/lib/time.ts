/**
 * Typed epoch-time module for the Worker auth/revocation plane.
 *
 * Canonical unit: milliseconds (EpochMillis).
 * JWT claims stay seconds on the wire (EpochSeconds); convert at the boundary.
 *
 * Branded types are compile-time only — zero runtime overhead.
 */

// ---------------------------------------------------------------------------
// Branded types
// ---------------------------------------------------------------------------

/** Unix epoch time in milliseconds. The canonical unit for this Worker. */
export type EpochMillis = number & { readonly __brand: "EpochMillis" };

/** Unix epoch time in seconds (RFC 7519 NumericDate). Used for JWT claims. */
export type EpochSeconds = number & { readonly __brand: "EpochSeconds" };

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/** Returns the current time as EpochMillis (wraps Date.now()). */
export function nowMs(): EpochMillis {
  return Date.now() as EpochMillis;
}

/** Returns the current time as EpochSeconds (Math.floor(Date.now() / 1000)). */
export function nowSeconds(): EpochSeconds {
  return Math.floor(Date.now() / 1000) as EpochSeconds;
}

// ---------------------------------------------------------------------------
// Converters
// ---------------------------------------------------------------------------

/**
 * Converts EpochSeconds to EpochMillis by multiplying by 1000.
 * Lossless: no precision is lost in this direction.
 */
export function secondsToMillis(s: EpochSeconds): EpochMillis {
  return ((s as number) * 1000) as EpochMillis;
}

/**
 * Converts EpochMillis to EpochSeconds via Math.floor(ms / 1000).
 *
 * LOSSY: drops the sub-second remainder (0–999 ms). This is NOT a true
 * inverse of secondsToMillis — round-tripping ms through seconds loses
 * the fractional part. Never use this to convert a tombstone timestamp
 * for a revocation comparison; keep comparisons in EpochMillis.
 */
export function millisToSeconds(ms: EpochMillis): EpochSeconds {
  return Math.floor((ms as number) / 1000) as EpochSeconds;
}

// ---------------------------------------------------------------------------
// Boundary casts (for trusted sources: validated D1 rows, verified JWT payloads)
// ---------------------------------------------------------------------------

/**
 * Casts a raw number from a trusted source (D1 row, verified JWT claim) to EpochMillis.
 * Only use at package/module boundaries where the unit is known to be milliseconds.
 */
export function asEpochMillis(n: number): EpochMillis {
  return n as EpochMillis;
}

/**
 * Casts a raw number from a trusted source (D1 row, verified JWT claim) to EpochSeconds.
 * Only use at package/module boundaries where the unit is known to be seconds.
 */
export function asEpochSeconds(n: number): EpochSeconds {
  return n as EpochSeconds;
}

// ---------------------------------------------------------------------------
// Revocation-safety primitive
// ---------------------------------------------------------------------------

/**
 * Returns true if a session's issuedAt timestamp strictly precedes the
 * revocation tombstone — i.e., the session was minted before the kill-switch
 * was set and should be rejected.
 *
 * Strict less-than (<): a token issued AT the exact tombstone millisecond is
 * NOT revoked. The consuming feature WI must confirm this matches intended
 * kill-switch semantics and may change to <= if at-cutoff tokens should be revoked.
 *
 * Pure: no I/O, no Date.now() inside — fully deterministic and testable.
 *
 * Both parameters are EpochMillis. If you have an EpochSeconds value (e.g., a
 * JWT issued_at claim), convert it first via secondsToMillis() — passing an
 * EpochSeconds where EpochMillis is required is a compile-time type error.
 */
export function isIssuedBeforeRevocation(
  issuedAt: EpochMillis,
  revokedBefore: EpochMillis,
): boolean {
  return issuedAt < revokedBefore;
}
