import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ProfileStore,
  profileEnvironment,
  selectedProfile,
} from "../src/profiles";
import { sessionKey } from "../src/store";

describe("host credential profiles", () => {
  let root: string;
  let store: ProfileStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tila-profile-"));
    store = new ProfileStore(join(root, "tila"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  function registration(id = "one") {
    const config_dir = join(root, id);
    mkdirSync(config_dir, { mode: 0o700 });
    const launcher = join(root, `${id}-launcher`);
    writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    return {
      id,
      harness: "claude-code" as const,
      launcher,
      config_dir,
      account: "one@example.test",
      credential_store: "file" as const,
      env_allowlist: ["ALLOWED"],
    };
  }
  it("coexists, keeps account identifiers private, and cannot reuse a removed revision", async () => {
    const input = registration();
    const one = store.add(input);
    const two = store.add({
      ...registration("two"),
      account: "two@example.test",
    });
    expect(store.list().map((p) => p.id)).toEqual(["one", "two"]);
    expect(
      readFileSync(join(store.root, "profiles.json"), "utf8"),
    ).not.toContain("@example.test");
    const otherHost = new ProfileStore(join(root, "other-host"));
    expect(otherHost.add(input).account_ref).not.toBe(one.account_ref);
    expect(
      await store.verify("one", 1, async () => input.account),
    ).toMatchObject({ verification: "declared", profile_revision: 1 });
    await expect(
      store.verify("one", 1, async () => "two@example.test"),
    ).rejects.toMatchObject({ code: "profile-mismatch" });
    store.remove("one");
    expect(store.add(input).revision).toBe(2);
    expect(() => store.get("one", 1)).toThrow(/revision/);
    expect(store.get("two")).toEqual(two);
  });
  it("rejects account or revision changes during verification", async () => {
    const input = registration();
    store.add(input);
    await expect(
      store.verify("one", 1, async () => {
        store.add(input);
        return input.account;
      }),
    ).rejects.toMatchObject({ code: "profile-mismatch" });
  });
  it("checks profile files, symlinks, launcher and config ownership modes on every load", () => {
    const input = registration();
    store.add(input);
    chmodSync(input.launcher, 0o777);
    expect(() => store.get("one")).toThrow(/executable/);
    chmodSync(input.launcher, 0o700);
    chmodSync(input.config_dir, 0o755);
    expect(() => store.list()).toThrow(/0700/);
    chmodSync(input.config_dir, 0o700);
    const file = join(store.root, "profiles.json");
    chmodSync(file, 0o644);
    expect(() => store.list()).toThrow(/owner-only/);
    rmSync(file);
    symlinkSync(join(root, "missing"), file);
    expect(() => store.list()).toThrow();
  });
  it("passes only allowed environment keys and pins the selected provider home", () => {
    const profile = store.add(registration());
    const env = profileEnvironment(profile, {
      PATH: "/bin",
      HOME: root,
      ALLOWED: "value",
      ANTHROPIC_API_KEY: "secret",
      TILA_TOKEN: "secret",
      CODEX_HOME: "wrong",
      CLAUDE_CONFIG_DIR: "wrong",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "secret",
    });
    expect(env).toEqual({
      PATH: "/bin",
      HOME: root,
      ALLOWED: "value",
      CLAUDE_CONFIG_DIR: profile.config_dir,
      TILA_PROFILE_ID: "one",
      TILA_PROFILE_REVISION: "1",
    });
    expect(
      profileEnvironment(undefined, {
        TILA_TOKEN: "secret",
        AWS_SECRET_ACCESS_KEY: "secret",
      }),
    ).toEqual({});
    expect(selectedProfile(env)).toEqual({ id: "one", revision: 1 });
    expect(() => selectedProfile({ TILA_PROFILE_ID: "one" })).toThrow();
  });
  it("qualifies native-session keys without changing legacy identities", () => {
    const legacy = createHash("sha256")
      .update(JSON.stringify(["project", "codex", "thread"]))
      .digest("hex");
    expect(sessionKey("project", "codex", "thread")).toBe(legacy);
    const keys = [
      undefined,
      { id: "one", revision: 1 },
      { id: "two", revision: 1 },
      { id: "one", revision: 2 },
    ].map((profile) => sessionKey("project", "codex", "thread", profile));
    expect(new Set(keys).size).toBe(4);
  });
});
