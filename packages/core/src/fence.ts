/**
 * Fence validation utilities.
 *
 * Fencing tokens use strict equality: claimedFence must === currentFence.
 * Both stale fences (claimed < current) and future fences (claimed > current) are invalid.
 * The DO increments the fence on each acquire, so the caller must present
 * the exact fence it received.
 */

export function validateFence(
  currentFence: number,
  claimedFence: number,
): boolean {
  return claimedFence === currentFence;
}

export function assertFence(currentFence: number, claimedFence: number): void {
  if (!validateFence(currentFence, claimedFence)) {
    throw new FenceError(currentFence, claimedFence);
  }
}

export class FenceError extends Error {
  constructor(
    public readonly currentFence: number,
    public readonly claimedFence: number,
  ) {
    super(`Fence mismatch: current=${currentFence}, claimed=${claimedFence}`);
    this.name = "FenceError";
  }
}
