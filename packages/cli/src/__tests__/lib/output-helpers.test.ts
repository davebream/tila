import type { TrustDecision } from "@tila/auth-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  eprintJson,
  eprintln,
  formatExpiry,
  formatResolvesHere,
  formatTrust,
} from "../../lib/output";

describe("eprintln", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the message to stderr with a newline", () => {
    eprintln("hello world");
    expect(stderrSpy).toHaveBeenCalledWith("hello world\n");
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("never writes to stdout", () => {
    eprintln("test");
    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});

describe("eprintJson", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes JSON to stderr", () => {
    eprintJson({ ok: false, message: "error" });
    expect(stderrSpy).toHaveBeenCalledWith(
      `${JSON.stringify({ ok: false, message: "error" }, null, 2)}\n`,
    );
    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});

describe("formatExpiry", () => {
  it("returns 'no expiry' for null", () => {
    const result = formatExpiry(null);
    expect(result).toMatch(/no expiry|never/i);
  });

  it("returns 'expired' for a past timestamp", () => {
    const pastMs = Date.now() - 60_000;
    expect(formatExpiry(pastMs)).toMatch(/expired/i);
  });

  it("returns a relative string for future ~1 hour", () => {
    const futureMs = Date.now() + 3_600_000;
    const result = formatExpiry(futureMs);
    // Should mention something like "59m" or "1h"
    expect(result).toMatch(/in \d+[mh]/i);
  });

  it("returns a relative string for future ~30 minutes", () => {
    const futureMs = Date.now() + 30 * 60 * 1000;
    const result = formatExpiry(futureMs);
    expect(result).toMatch(/in \d+m/i);
  });

  it("takes epoch ms (not seconds)", () => {
    // A value in epoch-seconds range (< 1e10) would be in the distant past for ms
    const epochSeconds = Math.floor(Date.now() / 1000) + 3600;
    // This should be "expired" since it's treated as ms (1970-era)
    expect(formatExpiry(epochSeconds)).toMatch(/expired/i);
  });
});

describe("formatTrust", () => {
  it("returns a string for trusted kind", () => {
    const decision: TrustDecision = { kind: "trusted" };
    const result = formatTrust(decision);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns a different string for spoof-worker-url-mismatch", () => {
    const decision: TrustDecision = {
      kind: "spoof-worker-url-mismatch",
      registered: "https://real.example",
      presented: "https://spoof.example",
    };
    const result = formatTrust(decision);
    expect(typeof result).toBe("string");
    // Should be visually distinct from trusted
    const trustedResult = formatTrust({ kind: "trusted" });
    expect(result).not.toBe(trustedResult);
  });

  it("returns a string for ci-home-store-disabled", () => {
    const decision: TrustDecision = { kind: "ci-home-store-disabled" };
    expect(typeof formatTrust(decision)).toBe("string");
  });

  it("returns a string for untrusted-needs-login", () => {
    const decision: TrustDecision = {
      kind: "untrusted-needs-login",
      reason: "unregistered",
    };
    expect(typeof formatTrust(decision)).toBe("string");
  });
});

describe("formatResolvesHere", () => {
  it("returns a marker string when active is true", () => {
    const result = formatResolvesHere(true);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns a different string when active is false", () => {
    const active = formatResolvesHere(true);
    const inactive = formatResolvesHere(false);
    expect(active).not.toBe(inactive);
  });
});
