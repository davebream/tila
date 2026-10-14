import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type SettingsReadPort,
  appliedSettingsDefinition,
  validateSettingsReceipt,
} from "@tila/core";
import type { SettingsReceipt } from "@tila/schemas";
import type { SettingsTransferMethods } from "tila-sdk";
import { cliError } from "./schema-transfer";

export function settingsReadPort(
  methods: SettingsTransferMethods,
): SettingsReadPort {
  return {
    ...methods.read,
    definitions: async () =>
      appliedSettingsDefinition(await methods.read.definitions()),
  };
}
/** Atomic private replacement. A durable uncertain record always precedes writes. */
export function saveSettingsReceipt(path: string, receipt: SettingsReceipt) {
  if (
    existsSync(path) &&
    (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
  )
    throw cliError(
      "unsafe-resume-file",
      "Resume destination must be a regular file.",
    );
  const temp = join(
    dirname(path),
    `.${basename(path)}.${crypto.randomUUID()}.tmp`,
  );
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, path);
  } catch (error) {
    unlinkSync(temp);
    throw error;
  }
}
export async function loadSettingsReceipt(path: string, projectId: string) {
  if (
    !existsSync(path) ||
    !lstatSync(path).isFile() ||
    lstatSync(path).isSymbolicLink()
  )
    throw cliError(
      "unsafe-resume-file",
      "Resume receipt must be a regular file.",
    );
  if ((lstatSync(path).mode & 0o077) !== 0)
    throw cliError(
      "unsafe-resume-file",
      "Resume receipt must be private; run chmod 600 on this file.",
    );
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw cliError("invalid-receipt", "Could not read the settings receipt.");
  }
  return validateSettingsReceipt(raw, projectId);
}
