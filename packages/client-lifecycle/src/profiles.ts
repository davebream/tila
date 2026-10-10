import { execFileSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  constants,
  accessSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  type CredentialProfile,
  CredentialProfileFileSchema,
  CredentialProfileSchema,
  type ProfileEvidence,
} from "@tila/schemas";
import lockfile from "proper-lockfile";
import { CodexObserver } from "./codex";

export class ProfileMismatchError extends Error {
  readonly code = "profile-mismatch";
}
export type ProfileRegistration = Omit<
  CredentialProfile,
  "revision" | "account_ref"
> & { account: string };
const BASE_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "COLORTERM",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SSH_AUTH_SOCK",
];
const RESERVED_ENV =
  /^(TILA_|ACTIONS_ID_TOKEN_REQUEST_|CODEX_HOME$|CLAUDE_CONFIG_DIR$)/;

/** Explicit process environment; never inherit ambient provider or Tila tokens. */
export function profileEnvironment(
  profile?: CredentialProfile,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of new Set([...BASE_ENV, ...(profile?.env_allowlist ?? [])])) {
    if (!RESERVED_ENV.test(key) && source[key] !== undefined)
      env[key] = source[key];
  }
  if (profile) {
    env[profile.harness === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"] =
      profile.config_dir;
    env.TILA_PROFILE_ID = profile.id;
    env.TILA_PROFILE_REVISION = String(profile.revision);
    if (profile.endpoint)
      env[
        profile.harness === "codex" ? "OPENAI_BASE_URL" : "ANTHROPIC_BASE_URL"
      ] = profile.endpoint;
  }
  return env;
}
export function selectedProfile(
  source: NodeJS.ProcessEnv = process.env,
): { id: string; revision: number } | undefined {
  if (!source.TILA_PROFILE_ID && !source.TILA_PROFILE_REVISION)
    return undefined;
  const revision = Number(source.TILA_PROFILE_REVISION);
  if (
    !source.TILA_PROFILE_ID ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(source.TILA_PROFILE_ID) ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  )
    throw new ProfileMismatchError(
      "Profile selection requires a valid ID and pinned revision",
    );
  return { id: source.TILA_PROFILE_ID, revision };
}
function pathExists(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function owned(stat: NonNullable<ReturnType<typeof lstatSync>>) {
  return process.getuid === undefined || stat.uid === process.getuid();
}
function readPrivate(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      !owned(stat) ||
      (stat.mode & 0o077) !== 0 ||
      stat.nlink !== 1
    )
      throw new ProfileMismatchError(
        "Profile files must be owner-only regular files",
      );
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}
function validatePaths(profile: CredentialProfile) {
  if (!isAbsolute(profile.launcher) || !isAbsolute(profile.config_dir))
    throw new ProfileMismatchError(
      "Profile launcher and config directory must be absolute",
    );
  const launcher = lstatSync(profile.launcher);
  const config = lstatSync(profile.config_dir);
  if (
    !launcher.isFile() ||
    (!owned(launcher) && launcher.uid !== 0) ||
    (launcher.mode & 0o022) !== 0
  )
    throw new ProfileMismatchError(
      "Profile launcher must be a trusted regular executable",
    );
  if (!config.isDirectory() || !owned(config) || (config.mode & 0o077) !== 0)
    throw new ProfileMismatchError(
      "Profile config directory must be owned by this user with mode 0700",
    );
  accessSync(profile.launcher, constants.X_OK);
}

export async function readProfileAccount(
  profile: CredentialProfile,
): Promise<string | null> {
  const env = profileEnvironment(profile);
  if (profile.harness === "claude-code") {
    try {
      const result = JSON.parse(
        execFileSync(profile.launcher, ["auth", "status", "--json"], {
          env,
          timeout: 5000,
          maxBuffer: 64 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
          encoding: "utf8",
        }),
      );
      return result.loggedIn === true && typeof result.email === "string"
        ? result.email
        : null;
    } catch {
      return null;
    }
  }
  const observer = new CodexObserver(profile.launcher, env);
  try {
    return await observer.account();
  } catch {
    return null;
  } finally {
    observer.close();
  }
}

export class ProfileStore {
  constructor(
    readonly root = process.env.TILA_HOME || join(homedir(), ".tila"),
  ) {}
  private guard(create = false) {
    if (create) mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.root);
    if (!stat.isDirectory() || !owned(stat) || (stat.mode & 0o022) !== 0)
      throw new ProfileMismatchError(
        "Tila home must be an owned directory without group/other writes",
      );
  }
  private file() {
    return join(this.root, "profiles.json");
  }
  private load() {
    this.guard();
    if (!pathExists(this.file()))
      return CredentialProfileFileSchema.parse({ version: 1, profiles: [] });
    return CredentialProfileFileSchema.parse(
      JSON.parse(readPrivate(this.file())),
    );
  }
  private secret(create = false) {
    this.guard(create);
    const path = join(this.root, "profile-account-key");
    if (create && !existsSync(path)) {
      try {
        writeFileSync(path, randomBytes(32).toString("hex"), {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const secret = readPrivate(path);
    if (!/^[a-f0-9]{64}$/.test(secret))
      throw new ProfileMismatchError("Invalid local account-reference key");
    return secret;
  }
  private accountRef(account: string, create = false) {
    if (!account.trim())
      throw new ProfileMismatchError("An account identifier is required");
    return createHmac("sha256", this.secret(create))
      .update(account.trim().toLowerCase())
      .digest("hex");
  }
  list(): CredentialProfile[] {
    if (!pathExists(this.root)) return [];
    const profiles = this.load().profiles;
    for (const profile of profiles) validatePaths(profile);
    return profiles;
  }
  get(id: string, revision?: number): CredentialProfile {
    const profile = this.list().find((item) => item.id === id);
    if (!profile || (revision !== undefined && profile.revision !== revision))
      throw new ProfileMismatchError(
        "Profile is missing or its pinned revision changed",
      );
    return profile;
  }
  private update(
    change: (
      file: ReturnType<typeof CredentialProfileFileSchema.parse>,
    ) => void,
  ) {
    this.guard(true);
    const release = lockfile.lockSync(this.file(), { realpath: false });
    const temporary = join(this.root, `.profiles-${randomUUID()}.json`);
    try {
      const file = this.load();
      change(file);
      const fd = openSync(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(
          fd,
          JSON.stringify(CredentialProfileFileSchema.parse(file), null, 2),
        );
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, this.file());
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
      release();
    }
  }
  add(input: ProfileRegistration): CredentialProfile {
    let saved: CredentialProfile | undefined;
    this.update((file) => {
      const old = file.profiles.find((profile) => profile.id === input.id);
      const { account, ...settings } = input;
      saved = CredentialProfileSchema.parse({
        ...settings,
        launcher: realpathSync(input.launcher),
        config_dir: input.config_dir,
        revision:
          Math.max(
            old?.revision ?? 0,
            Object.hasOwn(file.revisions, input.id)
              ? file.revisions[input.id]
              : 0,
          ) + 1,
        account_ref: this.accountRef(account, true),
      });
      validatePaths(saved);
      file.revisions[saved.id] = saved.revision;
      file.profiles = [
        ...file.profiles.filter((profile) => profile.id !== saved?.id),
        saved,
      ];
    });
    if (!saved) throw new Error("Profile was not saved");
    return saved;
  }
  remove(id: string) {
    this.update((file) => {
      const old = file.profiles.find((profile) => profile.id === id);
      if (!old) throw new ProfileMismatchError("Profile is not registered");
      file.revisions[id] = Math.max(
        Object.hasOwn(file.revisions, id) ? file.revisions[id] : 0,
        old.revision,
      );
      file.profiles = file.profiles.filter((profile) => profile.id !== id);
    });
  }
  async verify(
    id: string,
    revision?: number,
    readAccount = readProfileAccount,
  ): Promise<ProfileEvidence> {
    const profile = this.get(id, revision);
    const account = await readAccount(profile);
    if (!account || this.accountRef(account) !== profile.account_ref)
      throw new ProfileMismatchError(
        "Selected profile is unauthenticated or its account changed",
      );
    // Re-read after external I/O to reject concurrent profile changes.
    if (this.get(id, profile.revision).account_ref !== profile.account_ref)
      throw new ProfileMismatchError("Profile changed during verification");
    return {
      profile_id: profile.id,
      profile_revision: profile.revision,
      account_ref: profile.account_ref,
      verification: "declared",
    };
  }
}
