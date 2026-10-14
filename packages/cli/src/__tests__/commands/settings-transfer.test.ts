import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsReceipt } from "@tila/core";
import { SettingsPlanSchema } from "@tila/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadSettingsReceipt,
  saveSettingsReceipt,
} from "../../lib/settings-transfer";
const root = mkdtempSync(join(tmpdir(), "tila-settings-cli-"));
const methods = vi.hoisted(() => ({
  read: { identity: vi.fn() },
  execute: vi.fn(),
}));
vi.mock("tila-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("tila-sdk")>()),
  createSettingsTransferMethods: () => methods,
}));
vi.mock("../../context", () => ({
  resolveContext: async () => ({
    client: {},
    config: { project_id: "destination" },
  }),
  requireClient: (ctx: { client: object }) => ctx.client,
}));
vi.mock("../../lib/output", () => ({
  jsonArg: { json: { type: "boolean", default: false } },
  printJson: vi.fn(),
  outputText: vi.fn(),
  rawOutput: vi.fn(),
  exit: vi.fn(),
}));
import type { CommandDef } from "citty";
import command from "../../commands/settings";
import { printJson } from "../../lib/output";
function sub(name: string) {
  const result = (command.subCommands as Record<string, CommandDef>)[name];
  if (!result.run) throw new Error("Missing command");
  return result;
}
async function run(name: string, args: Record<string, unknown>) {
  const cmd = sub(name);
  await (cmd.run as (ctx: object) => Promise<void>)({
    cmd,
    args: { _: [], json: true, ...args },
    rawArgs: [],
  });
}
async function receipt() {
  const c = { status: "omitted", scope: "visible", unavailable_fields: [] };
  return createSettingsReceipt(
    SettingsPlanSchema.parse({
      format: "tila-settings-plan",
      version: 1,
      operation_id: crypto.randomUUID(),
      project_id: "destination",
      creator_member: "principal:owner",
      mappings: {
        identities: {},
        profiles: {},
        resources: { agents: {}, rooms: {}, signal_groups: {} },
      },
      actions: [],
      references: [],
      removals: [],
      warnings: [],
      coverage: { definitions: c, agents: c, rooms: c, signal_groups: c },
    }),
  );
}
afterEach(() => {
  vi.clearAllMocks();
});
describe("settings CLI receipts", () => {
  it("atomically creates/replaces a private receipt and validates it after reload", async () => {
    const file = join(root, "private.json");
    const value = await receipt();
    saveSettingsReceipt(file, value);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await loadSettingsReceipt(file, "destination")).toEqual(value);
    saveSettingsReceipt(file, value);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(value);
    await expect(loadSettingsReceipt(file, "other")).rejects.toMatchObject({
      code: "project-mismatch",
    });
    chmodSync(file, 0o644);
    await expect(
      loadSettingsReceipt(file, "destination"),
    ).rejects.toMatchObject({ code: "unsafe-resume-file" });
  });
  it("prints the exact plan/outcomes without applying unless explicitly requested", async () => {
    const file = join(root, "preview.json");
    saveSettingsReceipt(file, await receipt());
    await run("resume", { file, apply: false });
    expect(methods.execute).not.toHaveBeenCalled();
    expect(printJson).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "preview",
        plan: expect.objectContaining({ project_id: "destination" }),
      }),
    );
    methods.execute.mockImplementation(async (r, persist) => {
      persist(r);
      return r;
    });
    await run("resume", { file, apply: true, "confirm-removals": true });
    expect(methods.execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Function),
      { confirmRemovals: true },
    );
  });
  it("lists required mappings without destination reads or writes", async () => {
    const file = join(root, "source.toml");
    writeFileSync(
      file,
      `[tila_export]\nformat='tila-project-settings'\nformat_version=1\nproject_id='source'\nexported_at='2026-10-14T00:00:00.000Z'\n[coverage.definitions]\nstatus='omitted'\nscope='visible'\n[coverage.agents]\nstatus='omitted'\nscope='visible'\n[coverage.rooms]\nstatus='omitted'\nscope='visible'\n[coverage.signal_groups]\nstatus='read'\nscope='project'\n[settings.signal_groups.reviewers]\nname='Reviewers'\nsource_revision=7\nprincipal_ids=['source-person']\n`,
    );
    await run("import", { file });
    expect(methods.read.identity).not.toHaveBeenCalled();
    expect(methods.execute).not.toHaveBeenCalled();
    expect(printJson).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "mapping-required",
        references: ["principal:source-person"],
      }),
    );
  });
});
import { afterAll } from "vitest";
afterAll(() => rmSync(root, { recursive: true, force: true }));
