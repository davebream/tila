/**
 * Tests for the tila-token credential provider (C6).
 *
 * tila-token: reads a pre-minted bearer token from the caller-supplied context.
 * No network, no subprocess — pure config read. expires_at is always null.
 *
 * The resolved token is passed via ProviderContext.resolved_token (caller-resolved:
 * from --token flag, TILA_TOKEN env var, or config file — all precedence logic
 * lives in the CLI caller, not in this provider).
 */

import { InstanceKey } from "@tila/schemas";
import { describe, expect, it } from "vitest";
import { MissingTokenError } from "../errors.js";
import { FakeClock, FakePrompter, FakeRunCommand } from "./ports.js";
import { createTilaTokenProvider } from "./tila-token.js";
import type { ProviderContext } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(resolvedToken: string | undefined): ProviderContext {
  const clock = new FakeClock();
  const prompter = new FakePrompter();
  const frc = new FakeRunCommand();

  const fakeFetch: typeof globalThis.fetch = () =>
    Promise.reject(
      new Error("FakeFetch: unexpected fetch in tila-token tests"),
    );

  const ctx: ProviderContext = {
    instance_key: InstanceKey.parse("test-instance-key"),
    worker_url: "https://example.tila.dev",
    ports: {
      fetch: fakeFetch,
      prompter,
      env: { isCI: false, isTTY: true },
      clock,
      runCommand: frc.run,
    },
    config: { kind: "tila-token" },
    resolved_token: resolvedToken,
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tila-token provider", () => {
  const provider = createTilaTokenProvider();

  it("has kind tila-token", () => {
    expect(provider.kind).toBe("tila-token");
  });

  describe("mint()", () => {
    it("returns a MintedCredential with bearer token type and null expires_at", async () => {
      const ctx = makeCtx("my-bearer-token");
      const result = await provider.mint(ctx);

      expect(result.token).toBe("my-bearer-token");
      expect(result.token_type).toBe("bearer");
      expect(result.expires_at).toBeNull();
    });

    it("returns no scope field when none is configured", async () => {
      const ctx = makeCtx("some-token");
      const result = await provider.mint(ctx);
      expect(result.scope).toBeUndefined();
    });

    it("throws MissingTokenError when token is undefined", async () => {
      const ctx = makeCtx(undefined);
      await expect(provider.mint(ctx)).rejects.toThrow(MissingTokenError);
    });

    it("throws MissingTokenError when token is empty string", async () => {
      const ctx = makeCtx("");
      await expect(provider.mint(ctx)).rejects.toThrow(MissingTokenError);
    });

    it("throws MissingTokenError when token is whitespace-only", async () => {
      const ctx = makeCtx("   ");
      await expect(provider.mint(ctx)).rejects.toThrow(MissingTokenError);
    });

    it("MissingTokenError has code MISSING_TOKEN", async () => {
      const ctx = makeCtx(undefined);
      try {
        await provider.mint(ctx);
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(MissingTokenError);
        expect((e as MissingTokenError).code).toBe("MISSING_TOKEN");
      }
    });
  });

  describe("refresh()", () => {
    it("is a no-op that re-mints the same token", async () => {
      const ctx = makeCtx("my-refresh-token");
      const result = await provider.refresh(ctx, {} as never);
      expect(result.token).toBe("my-refresh-token");
      expect(result.expires_at).toBeNull();
    });
  });

  describe("revoke()", () => {
    it("is a no-op (clears local only, does not throw)", async () => {
      const ctx = makeCtx("some-token");
      await expect(provider.revoke(ctx, {} as never)).resolves.toBeUndefined();
    });
  });
});
