import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

const cases = [
  ["send", "--to", "broadcast", "--kind", "info"],
  ["inbox"],
  ["history", "--limit", "2"],
  ["ack", "signal-1"],
  ["group", "list"],
  ["group", "get", "team"],
  ["group", "set", "team", "--name", "Team", "--principals", "one,two"],
  ["group", "delete", "team"],
];
function invoke(parser: string, args: string[]) {
  return spawnSync("bun", [`${parser}.ts`, ...args], {
    cwd: import.meta.dirname,
    encoding: "utf8",
  });
}
test.each(cases)("shared signal handler parity: %s", (...args) => {
  const actual = invoke("gunshi", [...args, "--json"]);
  const expected = invoke("citty", [...args, "--json"]);
  expect(actual.status).toBe(0);
  expect(expected.status).toBe(0);
  expect(JSON.parse(actual.stdout)).toEqual(JSON.parse(expected.stdout));
});
test("records global string flag before nested command as an adoption blocker", () => {
  const actual = invoke("gunshi", [
    "--project",
    "project-one",
    "group",
    "list",
    "--json",
  ]);
  expect(actual.status).toBe(1);
  expect(JSON.parse(actual.stderr).error.message).toContain("project-one");
});
test("global string context after command works", () => {
  const actual = invoke("gunshi", [
    "history",
    "--project",
    "project-one",
    "--participant-id",
    "session-one",
    "--json",
  ]);
  expect(actual.status).toBe(0);
  expect(JSON.parse(actual.stdout).ok).toBe(true);
});
test("invalid input is structured and cannot run a mutation", () => {
  const result = invoke("gunshi", ["send", "--json"]);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr).error.retryable).toBe(false);
});

test("identity and project context remain isolated across invocations", () => {
  for (const participant of ["session-one", "session-two"]) {
    const actual = invoke("gunshi", [
      "group",
      "get",
      "team",
      "--project",
      "project-one",
      "--participant-id",
      participant,
      "--json",
    ]);
    expect(JSON.parse(actual.stdout).result.group).toMatchObject({
      project: "project-one",
      participant_id: participant,
    });
  }
});
test.each(["citty", "gunshi"])(
  "%s preserves structured stale-fence errors",
  (parser) => {
    const actual = invoke(parser, ["ack", "stale", "--json"]);
    expect(actual.status).toBe(1);
    expect(actual.stdout).toBe("");
    expect(JSON.parse(actual.stderr).error).toMatchObject({
      kind: "stale-fence",
      retryable: false,
    });
  },
);
