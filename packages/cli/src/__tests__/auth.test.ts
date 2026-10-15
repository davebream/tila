import * as fs from "node:fs";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  requireToken,
  requireTokenAsync,
  resolveToken,
  writeTokenFile,
} from "../auth";
import {
  InstanceKeyMismatchError,
  KeychainUnavailableError,
} from "../auth-store/errors";
import { HumanSessionStore } from "../auth-store/human-session-store";
import type { SecretStore } from "../auth-store/secret-store";
import { ThrowingSecretStore } from "../auth-store/testing";
import { findConfig, findTilaDir } from "../config";
import { resolveGithubRepoToken } from "../lib/github-exchange";
import { resetGlobalFlags, setGlobalFlags } from "../lib/global-flags";
import { humanSessionStore } from "../lib/human-login";

const { getHumanSession } = vi.hoisted(() => ({ getHumanSession: vi.fn() }));
// Keep the real filesystem implementation while observing auth read/write calls.
vi.mock("node:fs", { spy: true });
vi.mock("../config", () => ({ findConfig: vi.fn(), findTilaDir: vi.fn() }));
vi.mock("../lib/github-exchange", () => ({ resolveGithubRepoToken: vi.fn() }));
vi.mock("../lib/human-login", () => ({
  humanSessionStore: vi.fn(() => ({ get: getHumanSession })),
}));

const managedMarkers = [
  "TILA_RUN_SOCKET",
  "TILA_RUN_CAPABILITY",
  "TILA_LIFECYCLE_KEY",
  "CODEX_THREAD_ID",
] as const;
const originalTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
function setTTY(value: boolean) {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
}
const emptyValues = [undefined, "", " \t "];
const config = {
  project_id: "test",
  worker_url: "http://127.0.0.1:8787",
  schema_version: 1,
  tila_version: "0.10.0",
  created_at: "2026-10-15T00:00:00Z",
};

describe("project token resolution", () => {
  let dir: string;
  beforeEach(() => {
    vi.resetAllMocks();
    resetGlobalFlags();
    for (const name of [
      "TILA_TOKEN",
      "TILA_API_TOKEN",
      "CI",
      ...managedMarkers,
    ]) {
      vi.stubEnv(name, undefined);
    }
    setTTY(false);
    dir = mkdtempSync(join(tmpdir(), "tila-auth-"));
    vi.mocked(findConfig).mockReturnValue(config);
    vi.mocked(findTilaDir).mockReturnValue(dir);
    getHumanSession.mockResolvedValue({ token: "synthetic-human" });
    vi.mocked(resolveGithubRepoToken).mockResolvedValue("synthetic-exchange");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (originalTTY) Object.defineProperty(process.stdin, "isTTY", originalTTY);
    else Reflect.deleteProperty(process.stdin, "isTTY");
    resetGlobalFlags();
    rmSync(dir, { recursive: true, force: true });
  });

  const keychainNotice =
    "OS keychain unavailable; any remembered login was not used. Falling back to project credentials.";
  function spyOutput() {
    return {
      log: vi.spyOn(console, "log").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    };
  }
  function useMode(mode: "tila-token" | "github-repo") {
    vi.mocked(findConfig).mockReturnValue({
      ...config,
      auth: { mode },
      github: { host: "github.com", owner: "test", repo: "test" },
    });
  }

  const precedenceCases = [
    {
      name: "flag overrides primary, alias and file",
      flag: "synthetic-flag",
      primary: "synthetic-primary",
      alias: "synthetic-alias",
      expected: "synthetic-flag",
    },
    {
      name: "primary only",
      primary: "synthetic-primary",
      expected: "synthetic-primary",
    },
    {
      name: "trimmed primary only",
      primary: " \tsynthetic-primary\n",
      expected: "synthetic-primary",
    },
    {
      name: "trimmed primary overrides alias and file",
      primary: " synthetic-primary ",
      alias: "synthetic-alias",
      expected: "synthetic-primary",
    },
    ...emptyValues.map((primary, index) => ({
      name: `alias with empty primary variant ${index}`,
      primary,
      alias: " \tsynthetic-alias\n",
      expected: "synthetic-alias",
    })),
    {
      name: "explicit empty flag retains its value",
      flag: "",
      primary: "synthetic-primary",
      expected: "",
    },
    {
      name: "explicit flag retains whitespace",
      flag: " synthetic-flag ",
      primary: "synthetic-primary",
      expected: " synthetic-flag ",
    },
  ];
  describe.each(["tila-token", "github-repo"] as const)(
    "%s overrides",
    (mode) => {
      it.each(precedenceCases)(
        "$name without fallback access or writes",
        async (row) => {
          useMode(mode);
          writeFileSync(join(dir, ".env"), "TILA_API_TOKEN=synthetic-file\n");
          vi.stubEnv("TILA_TOKEN", row.primary);
          vi.stubEnv("TILA_API_TOKEN", "alias" in row ? row.alias : undefined);
          if ("flag" in row) setGlobalFlags({ token: row.flag });
          // Make the human branch eligible so a misplaced env lookup is observable.
          setTTY(true);
          const read = vi.mocked(fs.readFileSync).mockClear();
          const write = vi.mocked(fs.writeFileSync).mockClear();
          const mkdir = vi.mocked(fs.mkdirSync).mockClear();
          const log = vi.spyOn(console, "log").mockImplementation(() => {});
          const error = vi.spyOn(console, "error").mockImplementation(() => {});
          if (mode === "tila-token" || "flag" in row) {
            expect(resolveToken()).toBe(row.expected);
            expect(requireToken()).toBe(row.expected);
          }
          await expect(requireTokenAsync()).resolves.toBe(row.expected);
          expect(read).not.toHaveBeenCalled();
          expect(write).not.toHaveBeenCalled();
          expect(mkdir).not.toHaveBeenCalled();
          expect(humanSessionStore).not.toHaveBeenCalled();
          expect(resolveGithubRepoToken).not.toHaveBeenCalled();
          expect(log).not.toHaveBeenCalled();
          expect(error).not.toHaveBeenCalled();
        },
      );
    },
  );

  it.each(
    emptyValues.flatMap((primary, p) =>
      emptyValues.map((alias, a) => ({ primary, alias, name: `${p}/${a}` })),
    ),
  )(
    "falls through independently blank envs $name to the legacy file",
    async ({ primary, alias }) => {
      vi.stubEnv("TILA_TOKEN", primary);
      vi.stubEnv("TILA_API_TOKEN", alias);
      writeFileSync(join(dir, ".env"), "TILA_API_TOKEN=synthetic-file\n");
      expect(resolveToken()).toBe("synthetic-file");
      expect(requireToken()).toBe("synthetic-file");
      await expect(requireTokenAsync()).resolves.toBe("synthetic-file");
    },
  );
  it.each([
    "synthetic-file",
    "'synthetic-file'",
    '"synthetic-file"',
    "synthetic=file=with=equals",
  ])("preserves legacy parsing for %s", async (value) => {
    writeFileSync(
      join(dir, ".env"),
      `# ignored\n\nmalformed\nOTHER=ignored\nTILA_TOKEN=ignored-primary-file-key\n TILA_API_TOKEN = ${value}\n`,
    );
    const expected = value.replace(/^["']|["']$/g, "");
    expect(resolveToken()).toBe(expected);
    await expect(requireTokenAsync()).resolves.toBe(expected);
  });
  it.each([
    "",
    "# comment\nOTHER=ignored\nmalformed\nTILA_TOKEN=ignored-primary-file-key\n",
  ])(
    "reports actionable missing-token guidance without accepting other file keys",
    async (content) => {
      writeFileSync(join(dir, ".env"), content);
      expect(resolveToken()).toBeNull();
      for (const resolve of [() => requireToken(), () => requireTokenAsync()]) {
        try {
          await resolve();
          throw new Error("Expected missing-token error");
        } catch (error) {
          expect((error as Error).message).toContain("No API token found");
          expect((error as Error).message).toContain("Set TILA_TOKEN");
          expect((error as Error).message).toContain("legacy TILA_API_TOKEN");
          expect((error as Error).message).toContain(
            "TILA_API_TOKEN=your-token-here",
          );
          expect((error as Error).message).not.toContain(
            "ignored-primary-file-key",
          );
        }
      }
    },
  );
  it.each(["TILA_TOKEN", "TILA_API_TOKEN"])(
    "resolves %s without project config at helper level",
    async (name) => {
      vi.mocked(findConfig).mockReturnValue(null);
      vi.mocked(findTilaDir).mockReturnValue(null);
      vi.stubEnv(name, " synthetic-no-config ");
      expect(resolveToken()).toBe("synthetic-no-config");
      expect(requireToken()).toBe("synthetic-no-config");
      await expect(requireTokenAsync()).resolves.toBe("synthetic-no-config");
    },
  );

  it("reports a missing token when the legacy file is absent", async () => {
    expect(resolveToken()).toBeNull();
    expect(requireToken).toThrow("Set TILA_TOKEN");
    await expect(requireTokenAsync()).rejects.toThrow("Set TILA_TOKEN");
    expect(humanSessionStore).not.toHaveBeenCalled();
  });

  it("keeps GitHub async exchange ahead of the legacy file when envs are blank", async () => {
    useMode("github-repo");
    vi.stubEnv("TILA_TOKEN", " ");
    vi.stubEnv("TILA_API_TOKEN", "");
    writeFileSync(join(dir, ".env"), "TILA_API_TOKEN=synthetic-file\n");
    await expect(requireTokenAsync()).resolves.toBe("synthetic-exchange");
    expect(resolveGithubRepoToken).toHaveBeenCalledWith(findConfig(), dir);
    expect(humanSessionStore).not.toHaveBeenCalled();
  });
  it("preserves missing GitHub section and worker URL validation", async () => {
    vi.mocked(findConfig).mockReturnValue({
      ...config,
      auth: { mode: "github-repo" },
    });
    await expect(requireTokenAsync()).rejects.toThrow(
      "[github] section is missing",
    );
    vi.mocked(findConfig).mockReturnValue({
      ...config,
      auth: { mode: "github-repo" },
      github: { host: "github.com", owner: "test", repo: "test" },
      worker_url: undefined,
    });
    await expect(requireTokenAsync()).rejects.toThrow("worker_url");
    expect(resolveGithubRepoToken).not.toHaveBeenCalled();
    vi.mocked(findTilaDir).mockReturnValue(null);
    await expect(requireTokenAsync()).rejects.toThrow(
      "No .tila/config.toml found",
    );
  });
  it.each([undefined, "synthetic-primary"])(
    "preserves sync GitHub cache and async guidance (primary=%s)",
    (primary) => {
      useMode("github-repo");
      vi.stubEnv("TILA_TOKEN", primary);
      expect(resolveToken()).toBeNull();
      expect(requireToken).toThrow("requireTokenAsync()");
      writeFileSync(
        join(dir, ".session"),
        JSON.stringify({
          session_token: "synthetic-cache",
          expires_at: Date.now() / 1000 + 3600,
        }),
      );
      expect(resolveToken()).toBeNull();
      expect(requireToken()).toBe("synthetic-cache");
      writeFileSync(
        join(dir, ".session"),
        JSON.stringify({ session_token: "synthetic-expired", expires_at: 0 }),
      );
      expect(requireToken).toThrow("requireTokenAsync()");
    },
  );
  describe.each(["tila-token", "github-repo"] as const)(
    "%s human sessions",
    (mode) => {
      it.each([
        { tty: true, ci: undefined, human: true },
        { tty: true, ci: "1", human: false },
        { tty: false, ci: undefined, human: false },
      ])("retains eligibility tty=$tty ci=$ci", async ({ tty, ci, human }) => {
        useMode(mode);
        writeFileSync(join(dir, ".env"), "TILA_API_TOKEN=synthetic-file\n");
        setTTY(tty);
        vi.stubEnv("CI", ci);
        await expect(requireTokenAsync()).resolves.toBe(
          human
            ? "synthetic-human"
            : mode === "tila-token"
              ? "synthetic-file"
              : "synthetic-exchange",
        );
        expect(getHumanSession).toHaveBeenCalledTimes(human ? 1 : 0);
        if (human)
          expect(getHumanSession).toHaveBeenCalledWith(config.worker_url);
        expect(resolveGithubRepoToken).toHaveBeenCalledTimes(
          !human && mode === "github-repo" ? 1 : 0,
        );
      });
      it("falls through when an eligible human session is absent", async () => {
        useMode(mode);
        setTTY(true);
        getHumanSession.mockResolvedValue(null);
        writeFileSync(join(dir, ".env"), "TILA_API_TOKEN=synthetic-file\n");
        await expect(requireTokenAsync()).resolves.toBe(
          mode === "tila-token" ? "synthetic-file" : "synthetic-exchange",
        );
        expect(getHumanSession).toHaveBeenCalledOnce();
      });
      describe("with an unavailable keychain", () => {
        const fileToken = "synthetic-file";
        const fallback =
          mode === "tila-token" ? fileToken : "synthetic-exchange";
        beforeEach(() => {
          useMode(mode);
          setTTY(true);
          writeFileSync(join(dir, ".env"), `TILA_API_TOKEN=${fileToken}\n`);
        });

        it("continues to the project fallback with one token-free stderr notice", async () => {
          getHumanSession.mockRejectedValue(
            new KeychainUnavailableError(
              "get",
              new Error("synthetic-cause-secret"),
            ),
          );
          const output = spyOutput();
          await expect(requireTokenAsync()).resolves.toBe(fallback);
          expect(getHumanSession).toHaveBeenCalledOnce();
          expect(getHumanSession).toHaveBeenCalledWith(config.worker_url);
          expect(resolveGithubRepoToken).toHaveBeenCalledTimes(
            mode === "github-repo" ? 1 : 0,
          );
          expect(output.warn.mock.calls).toEqual([[keychainNotice]]);
          expect(output.log).not.toHaveBeenCalled();
          expect(output.error).not.toHaveBeenCalled();
          expect(JSON.stringify(output.warn.mock.calls)).not.toMatch(
            /synthetic-(file|exchange|human|cause-secret)|127\.0\.0\.1/,
          );
        });
        it("continues when the real session store reads an unreachable keychain", async () => {
          vi.mocked(humanSessionStore).mockReturnValue(
            new HumanSessionStore(new ThrowingSecretStore("get")),
          );
          const output = spyOutput();
          await expect(requireTokenAsync()).resolves.toBe(fallback);
          expect(humanSessionStore).toHaveBeenCalledOnce();
          expect(output.warn.mock.calls).toEqual([[keychainNotice]]);
        });
        it("recognizes the error by its code across duplicate module copies", async () => {
          // A second bundled copy of the class is not `instanceof` ours.
          class DuplicateKeychainUnavailableError extends Error {
            readonly code = "KEYCHAIN_UNAVAILABLE";
            readonly step = "get";
          }
          const duplicate = new DuplicateKeychainUnavailableError("duplicate");
          expect(duplicate).not.toBeInstanceOf(KeychainUnavailableError);
          getHumanSession.mockRejectedValue(duplicate);
          const output = spyOutput();
          await expect(requireTokenAsync()).resolves.toBe(fallback);
          expect(output.warn.mock.calls).toEqual([[keychainNotice]]);
        });
        it.each([
          ["unexpected error", () => new Error("synthetic unexpected")],
          [
            "identity mismatch",
            () => new InstanceKeyMismatchError("synthetic-a", "synthetic-b"),
          ],
          [
            "keychain look-alike without the code",
            () => new Error('Keychain unavailable at step "get"'),
          ],
          [
            "different keychain code",
            () =>
              Object.assign(new Error("synthetic locked"), {
                code: "KEYCHAIN_LOCKED",
              }),
          ],
          ["non-object failure", () => "KEYCHAIN_UNAVAILABLE"],
        ])("propagates a %s from the session lookup", async (_, make) => {
          const failure = make();
          getHumanSession.mockRejectedValue(failure);
          const output = spyOutput();
          await expect(requireTokenAsync()).rejects.toBe(failure);
          expect(resolveGithubRepoToken).not.toHaveBeenCalled();
          expect(output.warn).not.toHaveBeenCalled();
        });
        it.each([
          ["undecodable", "synthetic-not-json", SyntaxError],
          [
            "unrecognized",
            JSON.stringify({ token: "synthetic-other", expiresAt: 1 }),
            "Invalid stored login",
          ],
        ])(
          "propagates a %s stored login from the real session store",
          async (_, stored, expected) => {
            const secrets: SecretStore = {
              get: async () => stored,
              set: async () => {},
              delete: async () => {},
            };
            vi.mocked(humanSessionStore).mockReturnValue(
              new HumanSessionStore(secrets),
            );
            const output = spyOutput();
            await expect(requireTokenAsync()).rejects.toThrow(expected);
            expect(resolveGithubRepoToken).not.toHaveBeenCalled();
            expect(output.warn).not.toHaveBeenCalled();
          },
        );
      });
    },
  );
  it("keeps a stored human session ahead of the file with the real session store", async () => {
    setTTY(true);
    writeFileSync(join(dir, ".env"), "TILA_API_TOKEN=synthetic-file\n");
    const secrets: SecretStore = {
      get: async () =>
        JSON.stringify({
          token: "tila_u_synthetic",
          expiresAt: Date.now() + 60_000,
        }),
      set: async () => {},
      delete: async () => {},
    };
    vi.mocked(humanSessionStore).mockReturnValue(
      new HumanSessionStore(secrets),
    );
    await expect(requireTokenAsync()).resolves.toBe("tila_u_synthetic");
  });
  it.each([
    ["absent", undefined],
    ["without the token key", "# comment\nOTHER=ignored\n"],
  ])(
    "keeps the missing-token error, after the notice, when the keychain is unavailable and the file is %s",
    async (_, content) => {
      setTTY(true);
      if (content !== undefined) writeFileSync(join(dir, ".env"), content);
      getHumanSession.mockRejectedValue(new KeychainUnavailableError("get"));
      const output = spyOutput();
      const failure = await requireTokenAsync().then(
        () => undefined,
        (error: unknown) => error,
      );
      // The keychain failure is not surfaced; the existing guidance is.
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(KeychainUnavailableError);
      expect((failure as Error).message).toBe(
        "No API token found.\n\nSet TILA_TOKEN (or the legacy TILA_API_TOKEN environment alias), or add a token to .tila/.env:\n  TILA_API_TOKEN=your-token-here\n\nRun 'tila project create' to provision a new project, or 'tila init' to join an existing one.",
      );
      expect(getHumanSession).toHaveBeenCalledOnce();
      expect(output.warn.mock.calls).toEqual([[keychainNotice]]);
      expect(output.log).not.toHaveBeenCalled();
      expect(output.error).not.toHaveBeenCalled();
    },
  );
  it.each(managedMarkers)(
    "denies %s before a keychain lookup could fall back to the file",
    async (name) => {
      setTTY(true);
      vi.stubEnv(name, "synthetic-managed-marker");
      writeFileSync(join(dir, ".env"), "TILA_API_TOKEN=synthetic-file\n");
      getHumanSession.mockRejectedValue(new KeychainUnavailableError("get"));
      await expect(requireTokenAsync()).rejects.toMatchObject({
        code: "runtime-purpose-denied",
      });
      expect(getHumanSession).not.toHaveBeenCalled();
      expect(humanSessionStore).not.toHaveBeenCalled();
    },
  );
  it.each(managedMarkers)(
    "denies %s before operator credentials or fallbacks",
    async (name) => {
      vi.stubEnv(name, "synthetic-managed-marker");
      vi.stubEnv("TILA_TOKEN", "synthetic-primary");
      vi.stubEnv("TILA_API_TOKEN", "synthetic-alias");
      setGlobalFlags({ token: "synthetic-flag" });
      await expect(requireTokenAsync()).rejects.toMatchObject({
        code: "runtime-purpose-denied",
      });
      expect(findConfig).not.toHaveBeenCalled();
      expect(humanSessionStore).not.toHaveBeenCalled();
      expect(resolveGithubRepoToken).not.toHaveBeenCalled();
    },
  );
});

describe("writeTokenFile", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes token to .env file", () => {
    tempDir = mkdtempSync(join(tmpdir(), "tila-test-"));
    const tilaDir = join(tempDir, ".tila");

    writeTokenFile("tila_test000", tilaDir);

    const content = readFileSync(join(tilaDir, ".env"), "utf-8");
    expect(content).toBe("TILA_API_TOKEN=tila_test000\n");
  });

  it("creates .env with restrictive permissions (0o600)", () => {
    tempDir = mkdtempSync(join(tmpdir(), "tila-test-"));
    const tilaDir = join(tempDir, ".tila");

    writeTokenFile("tila_test000", tilaDir);

    const stats = statSync(join(tilaDir, ".env"));
    // 0o600 = owner read+write only
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("creates the directory if it does not exist", () => {
    tempDir = mkdtempSync(join(tmpdir(), "tila-test-"));
    const tilaDir = join(tempDir, "nested", ".tila");

    expect(() => writeTokenFile("tila_abc", tilaDir)).not.toThrow();
    const content = readFileSync(join(tilaDir, ".env"), "utf-8");
    expect(content).toContain("tila_abc");
  });
});
