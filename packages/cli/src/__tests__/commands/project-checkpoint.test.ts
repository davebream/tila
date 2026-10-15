import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  source: vi.fn(),
  plan: vi.fn(),
  restore: vi.fn(),
  text: vi.fn(),
  print: vi.fn(),
}));
vi.mock("../../lib/checkpoint", () => ({ checkpointSource: mocks.source }));
vi.mock("tila-sdk/backup", () => ({
  planProjectRecovery: mocks.plan,
  restoreProjectCheckpoint: mocks.restore,
}));
vi.mock("../../lib/output", () => ({ printJson: mocks.print }));
vi.mock("../../lib/prompts", () => ({
  text: mocks.text,
  isCancel: () => false,
  cancel: vi.fn(),
  note: vi.fn(),
}));
import restore from "../../commands/project/restore";
const source = { projectId: "p", infraToken: "secret" };
const plan = {
  operation_id: "operation",
  requested_at: "2026-01-02T00:00:00Z",
  checkpoint: { snapshot_at: "2026-01-01T00:00:00Z" },
  archive: "/backups/a.tila-backup",
  action: "restore",
};
const run = (args: Record<string, unknown>) =>
  (
    restore as unknown as {
      run(ctx: { args: Record<string, unknown> }): Promise<void>;
    }
  ).run({
    args: { directory: "/backups", to: plan.requested_at, json: true, ...args },
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.source.mockResolvedValue(source);
  mocks.plan.mockResolvedValue(plan);
  mocks.restore.mockResolvedValue({ ok: true, operation_id: "operation" });
});

describe("checkpoint restore CLI", () => {
  it("previews without confirmation or execution", async () => {
    await run({ "dry-run": true });
    expect(mocks.print).toHaveBeenCalledWith({ dry_run: true, ...plan });
    expect(mocks.text).not.toHaveBeenCalled();
    expect(mocks.restore).not.toHaveBeenCalled();
  });
  it("executes exactly the reviewed selection with --force and emits JSON", async () => {
    await run({ force: true });
    expect(mocks.text).not.toHaveBeenCalled();
    expect(mocks.restore).toHaveBeenCalledWith({ source, plan });
    expect(mocks.print).toHaveBeenCalledWith({
      ok: true,
      operation_id: "operation",
    });
  });
  it("requires the project name and cancels on a different answer", async () => {
    mocks.text.mockResolvedValue("other");
    await run({});
    expect(mocks.restore).not.toHaveBeenCalled();
  });
  it("fails without mutation when prompting is unavailable", async () => {
    mocks.text.mockRejectedValue(new Error("Noninteractive: use --force"));
    await expect(run({})).rejects.toThrow("Noninteractive");
    expect(mocks.restore).not.toHaveBeenCalled();
  });
  it("retains the operation ID in failure instructions", async () => {
    mocks.restore.mockRejectedValue(new Error("connection lost"));
    await expect(run({ force: true })).rejects.toThrow("--resume operation");
  });
});
