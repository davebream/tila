import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getGlobalFlags,
  parseGlobalFlags,
  resetGlobalFlags,
  setGlobalFlags,
} from "../../lib/global-flags";

beforeEach(() => {
  resetGlobalFlags();
});

afterEach(() => {
  resetGlobalFlags();
});

describe("parseGlobalFlags", () => {
  it("extracts --instance, --token=, --project in space-separated and = forms", () => {
    const result = parseGlobalFlags([
      "--instance",
      "a",
      "--token=b",
      "auth",
      "status",
      "--project",
      "p",
    ]);
    expect(result).toEqual({ instance: "a", token: "b", project: "p" });
  });

  it("returns empty object when no flags present", () => {
    expect(parseGlobalFlags(["auth", "status"])).toEqual({});
  });

  it("handles flags at different positions in argv", () => {
    const result = parseGlobalFlags([
      "task",
      "list",
      "--instance=prod",
      "--project",
      "my-proj",
    ]);
    expect(result).toEqual({ instance: "prod", project: "my-proj" });
  });

  it("handles --token with space-separated value", () => {
    const result = parseGlobalFlags(["--token", "secret123", "auth", "token"]);
    expect(result).toEqual({ token: "secret123" });
  });

  it("ignores unknown flags without crashing", () => {
    const result = parseGlobalFlags(["--unknown", "val", "--instance", "x"]);
    expect(result).toEqual({ instance: "x" });
  });
});

describe("global flags singleton", () => {
  it("getGlobalFlags returns empty object before setGlobalFlags", () => {
    expect(getGlobalFlags()).toEqual({});
  });

  it("setGlobalFlags then getGlobalFlags returns the stored value", () => {
    setGlobalFlags({ instance: "foo", token: "bar" });
    expect(getGlobalFlags()).toEqual({ instance: "foo", token: "bar" });
  });

  it("resetGlobalFlags clears the singleton", () => {
    setGlobalFlags({ instance: "foo", token: "bar", project: "baz" });
    resetGlobalFlags();
    expect(getGlobalFlags()).toEqual({});
  });

  it("setGlobalFlags overwrites previous value", () => {
    setGlobalFlags({ instance: "first" });
    setGlobalFlags({ project: "second" });
    expect(getGlobalFlags()).toEqual({ project: "second" });
  });
});
