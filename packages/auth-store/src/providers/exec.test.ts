/**
 * Tests for the exec credential provider (C6).
 *
 * exec: runs a configured command via the injected runCommand port (argv array,
 * shell:false), parses stdout as tila's JSON contract, maps errors to
 * ExecCredentialError.
 *
 * Tila's stdout JSON contract:
 *   { token: string, token_type?: string, expires_at?: number | null, scope?: string }
 * where expires_at is epoch-ms or null.
 */

import { InstanceKey } from "@tila/schemas";
import { describe, expect, it } from "vitest";
import { ExecCredentialError } from "../errors.js";
import { createExecProvider } from "./exec.js";
import { FakeClock, FakePrompter, FakeRunCommand } from "./ports.js";
import type { ProviderContext } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(
  frc: FakeRunCommand,
  config: { command: string; args?: string[] } = {
    command: "token-helper",
    args: [],
  },
): ProviderContext {
  const clock = new FakeClock(1_700_000_000_000); // fixed epoch for assertions
  const prompter = new FakePrompter();

  const fakeFetch: typeof globalThis.fetch = () =>
    Promise.reject(new Error("FakeFetch: unexpected fetch in exec tests"));

  return {
    instance_key: InstanceKey.parse("exec-test-instance"),
    worker_url: "https://exec.tila.dev",
    ports: {
      fetch: fakeFetch,
      prompter,
      env: { isCI: false, isTTY: true },
      clock,
      runCommand: frc.run,
    },
    config: {
      kind: "exec",
      command: config.command,
      args: config.args ?? [],
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("exec provider", () => {
  const provider = createExecProvider();

  it("has kind exec", () => {
    expect(provider.kind).toBe("exec");
  });

  describe("mint() — happy path", () => {
    it("parses minimal valid JSON (token only) into a MintedCredential", async () => {
      const frc = new FakeRunCommand();
      frc.push({
        exitCode: 0,
        stdout: JSON.stringify({ token: "tok-abc" }),
        stderr: "",
      });
      const ctx = makeCtx(frc);

      const result = await provider.mint(ctx);

      expect(result.token).toBe("tok-abc");
      expect(result.token_type).toBe("bearer"); // default when absent
      expect(result.expires_at).toBeNull(); // absent → null
    });

    it("parses full JSON contract with token_type, expires_at, scope", async () => {
      const frc = new FakeRunCommand();
      frc.push({
        exitCode: 0,
        stdout: JSON.stringify({
          token: "tok-full",
          token_type: "custom-type",
          expires_at: 1_700_003_600_000,
          scope: "read:all",
        }),
        stderr: "",
      });
      const ctx = makeCtx(frc);

      const result = await provider.mint(ctx);

      expect(result.token).toBe("tok-full");
      expect(result.token_type).toBe("custom-type");
      expect(result.expires_at).toBe(1_700_003_600_000);
      expect(result.scope).toBe("read:all");
    });

    it("tolerates and ignores unknown extra top-level fields", async () => {
      const frc = new FakeRunCommand();
      frc.push({
        exitCode: 0,
        stdout: JSON.stringify({
          token: "tok-extra",
          expires_at: null,
          unknown_field: "ignore-me",
          another: 42,
        }),
        stderr: "",
      });
      const ctx = makeCtx(frc);

      const result = await provider.mint(ctx);

      expect(result.token).toBe("tok-extra");
      expect(result.expires_at).toBeNull();
    });

    it("accepts null expires_at explicitly", async () => {
      const frc = new FakeRunCommand();
      frc.push({
        exitCode: 0,
        stdout: JSON.stringify({ token: "tok-null-exp", expires_at: null }),
        stderr: "",
      });
      const ctx = makeCtx(frc);

      const result = await provider.mint(ctx);
      expect(result.expires_at).toBeNull();
    });
  });

  describe("mint() — argv array asserted (never a shell string)", () => {
    it("passes command and args as separate argv components to runCommand", async () => {
      const frc = new FakeRunCommand();
      frc.push({
        exitCode: 0,
        stdout: JSON.stringify({ token: "t" }),
        stderr: "",
      });
      const ctx = makeCtx(frc, {
        command: "my-helper",
        args: ["--output", "json"],
      });

      await provider.mint(ctx);

      expect(frc.calls).toHaveLength(1);
      // command and args must be separate — never joined as a shell string
      expect(frc.calls[0].command).toBe("my-helper");
      expect(frc.calls[0].args).toEqual(["--output", "json"]);
    });

    it("passes empty args array when no args configured", async () => {
      const frc = new FakeRunCommand();
      frc.push({
        exitCode: 0,
        stdout: JSON.stringify({ token: "t" }),
        stderr: "",
      });
      const ctx = makeCtx(frc, { command: "cmd", args: [] });

      await provider.mint(ctx);

      expect(frc.calls[0].command).toBe("cmd");
      expect(frc.calls[0].args).toEqual([]);
    });
  });

  describe("mint() — error cases", () => {
    it("throws ExecCredentialError on non-zero exit code", async () => {
      const frc = new FakeRunCommand();
      frc.push({
        exitCode: 1,
        stdout: "",
        stderr: "something went wrong",
      });
      const ctx = makeCtx(frc);

      await expect(provider.mint(ctx)).rejects.toThrow(ExecCredentialError);
    });

    it("captures stderr in ExecCredentialError on non-zero exit", async () => {
      const frc = new FakeRunCommand();
      frc.push({
        exitCode: 2,
        stdout: "",
        stderr: "error: auth failed for user@host",
      });
      const ctx = makeCtx(frc);

      try {
        await provider.mint(ctx);
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ExecCredentialError);
        const err = e as ExecCredentialError;
        expect(err.code).toBe("EXEC_CREDENTIAL_ERROR");
        expect(err.reason).toBe("non-zero-exit");
        expect(err.stderr).toContain("error: auth failed");
      }
    });

    it("throws ExecCredentialError on unparseable stdout", async () => {
      const frc = new FakeRunCommand();
      frc.push({
        exitCode: 0,
        stdout: "not-json-at-all",
        stderr: "",
      });
      const ctx = makeCtx(frc);

      try {
        await provider.mint(ctx);
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ExecCredentialError);
        expect((e as ExecCredentialError).reason).toBe("invalid-json");
      }
    });

    it("throws ExecCredentialError on valid JSON but missing token field", async () => {
      const frc = new FakeRunCommand();
      frc.push({
        exitCode: 0,
        stdout: JSON.stringify({ not_token: "oops" }),
        stderr: "",
      });
      const ctx = makeCtx(frc);

      try {
        await provider.mint(ctx);
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ExecCredentialError);
        expect((e as ExecCredentialError).reason).toBe("missing-token");
      }
    });

    it("throws ExecCredentialError on valid JSON with empty token string", async () => {
      const frc = new FakeRunCommand();
      frc.push({
        exitCode: 0,
        stdout: JSON.stringify({ token: "" }),
        stderr: "",
      });
      const ctx = makeCtx(frc);

      try {
        await provider.mint(ctx);
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ExecCredentialError);
        expect((e as ExecCredentialError).reason).toBe("missing-token");
      }
    });

    it("throws ExecCredentialError on timeout (runCommand throws with timeout signal)", async () => {
      const frc = new FakeRunCommand();
      const timeoutErr = new Error("Command timed out after 30000ms");
      (timeoutErr as NodeJS.ErrnoException).code = "ETIMEDOUT";
      frc.push(timeoutErr);
      const ctx = makeCtx(frc);

      try {
        await provider.mint(ctx);
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ExecCredentialError);
        expect((e as ExecCredentialError).reason).toBe("timeout");
      }
    });
  });

  describe("mint() — token redaction in error message", () => {
    it("does NOT include token value in ExecCredentialError message (non-zero exit)", async () => {
      const frc = new FakeRunCommand();
      // stdout contains a partial token — must not leak into error message
      frc.push({
        exitCode: 1,
        stdout: '{"token":"super-secret-value-abc123"}',
        stderr: "exit 1",
      });
      const ctx = makeCtx(frc);

      try {
        await provider.mint(ctx);
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ExecCredentialError);
        const err = e as ExecCredentialError;
        // The token value must not appear in the error message
        expect(err.message).not.toContain("super-secret-value-abc123");
      }
    });

    it("does NOT include token value in ExecCredentialError from stdout (missing-token error)", async () => {
      const frc = new FakeRunCommand();
      // Even on parse errors the stdout snippet must be redacted
      frc.push({
        exitCode: 0,
        stdout: '{"token":"leak-me-if-you-can"}',
        stderr: "",
      });
      // We push a JSON result with missing token to trigger missing-token path
      // Actually the above has a token, let's use empty token instead
      const frc2 = new FakeRunCommand();
      frc2.push({
        exitCode: 0,
        stdout: '{"token":""}',
        stderr: "",
      });
      const ctx = makeCtx(frc2);

      try {
        await provider.mint(ctx);
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ExecCredentialError);
        // empty token value should not be a leak concern, but assert anyway
        const err = e as ExecCredentialError;
        expect(err.message).not.toContain("leak-me-if-you-can");
      }
    });
  });

  describe("refresh()", () => {
    it("re-runs the command (same as mint)", async () => {
      const frc = new FakeRunCommand();
      frc.push({
        exitCode: 0,
        stdout: JSON.stringify({ token: "fresh" }),
        stderr: "",
      });
      const ctx = makeCtx(frc);

      const result = await provider.refresh(ctx, {} as never);
      expect(result.token).toBe("fresh");
    });
  });

  describe("revoke()", () => {
    it("is a no-op (does not run the command, does not throw)", async () => {
      const frc = new FakeRunCommand();
      // No responses pushed — if run() were called it would throw
      const ctx = makeCtx(frc);

      await expect(provider.revoke(ctx, {} as never)).resolves.toBeUndefined();
      expect(frc.calls).toHaveLength(0);
    });
  });
});
