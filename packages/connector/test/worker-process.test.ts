import { expect, it, vi } from "vitest";
import { workerProcessAlive } from "./fixtures/worker-process";

it("pins only the executing worker and still rejects a replaced start identity", () => {
  const self = { pid: process.pid, started: "worker-start" };
  const checks = {
    processIdentity: vi.fn(() => self),
    processAlive: vi.fn(() => false),
  };
  const alive = workerProcessAlive(checks);
  expect(checks.processIdentity).toHaveBeenCalledExactlyOnceWith(process.pid);
  expect(alive({ ...self })).toBe(true);
  expect(alive({ ...self, started: "replacement-start" })).toBe(false);
  // Mutating fixture state must not mutate the measured start identity.
  self.started = "replacement-start";
  expect(alive(self)).toBe(false);
  expect(checks.processIdentity).toHaveBeenCalledTimes(1);
  expect(checks.processAlive).not.toHaveBeenCalled();
});

it("delegates absent and foreign owners to the real probe without caching them", () => {
  const checks = {
    processIdentity: vi.fn(() => ({
      pid: process.pid,
      started: "worker-start",
    })),
    processAlive: vi.fn(() => false),
  };
  const alive = workerProcessAlive(checks);
  const foreign = { pid: process.pid + 1, started: "worker-start" };
  checks.processAlive.mockReturnValueOnce(true);
  expect(alive(foreign)).toBe(true);
  expect(alive(foreign)).toBe(false);
  expect(alive(null)).toBe(false);
  expect(checks.processAlive.mock.calls).toEqual([
    [foreign],
    [foreign],
    [null],
  ]);
});

it("refuses to install the fixture probe without a measured worker identity", () => {
  const checks = { processIdentity: vi.fn(() => null), processAlive: vi.fn() };
  expect(() => workerProcessAlive(checks)).toThrow("identity unavailable");
  expect(checks.processAlive).not.toHaveBeenCalled();
});
