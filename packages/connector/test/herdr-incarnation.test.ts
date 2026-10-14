import type { Stats } from "node:fs";
import { expect, it, vi } from "vitest";
import { herdrServerInstance } from "../src/herdr";

const fixture = vi.hoisted(() => ({
  dev: 1,
  ino: 123,
  birthtimeMs: 100,
  ctimeMs: 100,
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  lstatSync: (path: string) =>
    ({
      ...fixture,
      uid: process.getuid?.(),
      mode: 0o600,
      isSymbolicLink: () => false,
      isDirectory: () => path === "/fixture",
      isSocket: () => path === "/fixture/api.sock",
    }) as Stats,
}));
it("rejects a replaced socket with reused device/inode but different incarnation timestamps", () => {
  const original = herdrServerInstance("/fixture/api.sock");
  expect(herdrServerInstance("/fixture/api.sock")).toBe(original);
  fixture.ctimeMs++;
  expect(herdrServerInstance("/fixture/api.sock")).not.toBe(original);
  fixture.ctimeMs--;
  fixture.birthtimeMs++;
  expect(herdrServerInstance("/fixture/api.sock")).not.toBe(original);
});
