import { runCommand } from "citty";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import command from "../../commands/service-account";

const patch = vi.hoisted(() => vi.fn());
vi.mock("../../context", () => ({
  resolveContext: async () => ({
    config: { project_id: "p" },
    client: { patch },
  }),
  requireClient: (ctx: { client: unknown }) => ctx.client,
}));
beforeEach(() => {
  patch
    .mockReset()
    .mockResolvedValue({ ok: true, service_account: { revision: 4 } });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it("parses service revisions and prints the response revision", async () => {
  await runCommand(command, {
    rawArgs: [
      "update",
      "service:ci",
      "--display-name",
      "CI",
      "--expected-revision",
      "3",
      "--json",
    ],
  });
  expect(patch).toHaveBeenCalledWith(
    "/projects/p/service-accounts/service%3Aci",
    { display_name: "CI", expected_revision: 3 },
  );
  expect(console.log).toHaveBeenCalledWith(
    expect.stringContaining('"revision":4'),
  );
});

it("parses workload revisions and preserves omission for both updates", async () => {
  await runCommand(command, {
    rawArgs: [
      "workload",
      "update",
      "service:ci",
      "--binding",
      "ci",
      "--expected-revision",
      "6",
    ],
  });
  expect(patch.mock.calls[0][1]).toMatchObject({ expected_revision: 6 });
  await runCommand(command, {
    rawArgs: ["workload", "update", "service:ci", "--binding", "ci"],
  });
  expect(patch.mock.calls[1][1].expected_revision).toBeUndefined();
  await runCommand(command, {
    rawArgs: ["update", "service:ci", "--display-name", "CI"],
  });
  expect(patch.mock.calls[2][1].expected_revision).toBeUndefined();
});

it.each(["0", "-1", "1.5", "bad", "9007199254740992"])(
  "rejects invalid revision %s before either request",
  async (revision) => {
    await expect(
      runCommand(command, {
        rawArgs: [
          "update",
          "service:ci",
          "--display-name",
          "CI",
          `--expected-revision=${revision}`,
        ],
      }),
    ).rejects.toThrow();
    await expect(
      runCommand(command, {
        rawArgs: [
          "workload",
          "update",
          "service:ci",
          "--binding",
          "ci",
          `--expected-revision=${revision}`,
        ],
      }),
    ).rejects.toThrow();
    expect(patch).not.toHaveBeenCalled();
  },
);
