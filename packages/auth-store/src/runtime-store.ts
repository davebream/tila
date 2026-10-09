import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { KeyringSecretStore } from "./keyring-secret-store.js";
import type { SecretStore } from "./secret-store.js";

export interface RuntimeEnrollmentSecret {
  version: 1;
  deployment: string;
  instanceId: string;
  projectId: string;
  enrollmentId: string;
  installationId: string;
  privateJwk: JsonWebKey;
  token?: string;
}

const service = "tila:runtime-enrollment";
function account(instance: string, project: string, enrollment: string) {
  return createHash("sha256")
    .update(JSON.stringify([instance, project, enrollment]))
    .digest("hex");
}

/** Explicit opt-in headless store. Never used as a keychain fallback. */
export class RuntimeFileSecretStore implements SecretStore {
  constructor(private directory: string) {
    if (!isAbsolute(directory))
      throw new Error("Runtime secret directory must be absolute");
  }
  private async root() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error(
        "Runtime secret directory must be owned by this user with mode 0700",
      );
  }
  private path(name: string, key: string) {
    return join(
      this.directory,
      createHash("sha256").update(`${name}\0${key}`).digest("hex"),
    );
  }
  async get(name: string, key: string) {
    await this.root();
    let file: Awaited<ReturnType<typeof open>>;
    try {
      file = await open(
        this.path(name, key),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw new Error(
          "Runtime secret file must be owned by this user with mode 0600",
        );
      return await file.readFile("utf8");
    } finally {
      await file.close();
    }
  }
  async set(name: string, key: string, value: string) {
    await this.root();
    const target = this.path(name, key);
    const temporary = `${target}.${randomUUID()}`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(value);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, target);
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async delete(name: string, key: string) {
    await this.root();
    await rm(this.path(name, key), { force: true });
  }
}

/** Separate namespace and write policy from general operator credentials. */
export class RuntimeEnrollmentStore {
  constructor(private secrets: SecretStore = new KeyringSecretStore()) {}
  async get(
    instance: string,
    project: string,
    enrollment: string,
  ): Promise<RuntimeEnrollmentSecret | null> {
    const raw = await this.secrets.get(
      service,
      account(instance, project, enrollment),
    );
    if (raw === null) return null;
    const value = JSON.parse(raw) as RuntimeEnrollmentSecret;
    if (
      value.version !== 1 ||
      value.instanceId !== instance ||
      value.projectId !== project ||
      value.enrollmentId !== enrollment ||
      !value.privateJwk?.d
    )
      throw new Error("Invalid runtime enrollment storage binding");
    return value;
  }
  async save(value: RuntimeEnrollmentSecret) {
    const key = account(value.instanceId, value.projectId, value.enrollmentId);
    await this.secrets.set(service, key, JSON.stringify(value));
    if ((await this.secrets.get(service, key)) !== JSON.stringify(value))
      throw new Error("Runtime credential storage verification failed");
  }
  async probe() {
    const key = `probe-${randomUUID()}`;
    try {
      await this.secrets.set(service, key, key);
      if ((await this.secrets.get(service, key)) !== key)
        throw new Error("Runtime secret store is unavailable");
    } finally {
      await this.secrets.delete(service, key);
    }
  }
  async remove(instance: string, project: string, enrollment: string) {
    await this.secrets.delete(service, account(instance, project, enrollment));
  }
}
