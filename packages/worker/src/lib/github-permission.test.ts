import { describe, expect, it } from "vitest";
import {
  PERMISSION_HIERARCHY,
  normalizeGitHubPermission,
} from "./github-permission";

describe("PERMISSION_HIERARCHY", () => {
  it("has the 6 GitHub tiers in ascending order", () => {
    expect(PERMISSION_HIERARCHY.none).toBe(0);
    expect(PERMISSION_HIERARCHY.read).toBe(1);
    expect(PERMISSION_HIERARCHY.triage).toBe(2);
    expect(PERMISSION_HIERARCHY.write).toBe(3);
    expect(PERMISSION_HIERARCHY.maintain).toBe(4);
    expect(PERMISSION_HIERARCHY.admin).toBe(5);
  });
});

describe("normalizeGitHubPermission", () => {
  it("maps none → read (least privilege)", () => {
    expect(normalizeGitHubPermission("none")).toBe("read");
  });

  it("maps read → read", () => {
    expect(normalizeGitHubPermission("read")).toBe("read");
  });

  it("maps triage → read", () => {
    expect(normalizeGitHubPermission("triage")).toBe("read");
  });

  it("maps write → write", () => {
    expect(normalizeGitHubPermission("write")).toBe("write");
  });

  it("maps maintain → write", () => {
    expect(normalizeGitHubPermission("maintain")).toBe("write");
  });

  it("maps admin → admin", () => {
    expect(normalizeGitHubPermission("admin")).toBe("admin");
  });

  it("maps unknown string → read (least privilege)", () => {
    expect(normalizeGitHubPermission("unknown-tier")).toBe("read");
    expect(normalizeGitHubPermission("")).toBe("read");
  });
});
