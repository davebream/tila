import { randomBytes, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Ledger, LedgerSchema } from "@tila/schemas";

export type { Ledger, Registration } from "@tila/schemas";

export function privatePath(
  path: string,
  kind: "directory" | "file" | "socket",
): void {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    !(kind === "directory"
      ? stat.isDirectory()
      : kind === "file"
        ? stat.isFile()
        : stat.isSocket())
  )
    throw new Error(
      "Connector path is not private and owned by the current user",
    );
}
export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  privatePath(path, "directory");
}
export function readPrivate(path: string): string {
  privatePath(dirname(path), "directory");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 1024 * 1024
    )
      throw new Error("Connector file is unsafe");
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}
export function atomicPrivate(path: string, value: unknown): void {
  privatePath(dirname(path), "directory");
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}
export class ConnectorStore {
  constructor(
    readonly root = join(
      process.env.TILA_HOME || join(homedir(), ".tila"),
      "connector",
    ),
  ) {
    privateDirectory(root);
  }
  read(): Ledger {
    try {
      return LedgerSchema.parse(
        JSON.parse(readPrivate(join(this.root, "ledger.json"))),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return {
        version: 1,
        hostRef: randomUUID(),
        heartbeat: 0,
        registrations: [],
      };
    }
  }
  write(ledger: Ledger): void {
    atomicPrivate(join(this.root, "ledger.json"), LedgerSchema.parse(ledger));
  }
}
