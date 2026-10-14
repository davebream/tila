import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  CompositeDiscovery,
  ConnectorControl,
  ConnectorStore,
  HostConnector,
} from "@tila/connector";
import { runCommand } from "citty";
import { afterEach, expect, it, vi } from "vitest";
import { createHostConnector } from "../../commands/connector";
import command from "../../commands/connector-herdr";

vi.mock("../../lib/connector-runtime", () => ({
  relayFactory: { start: vi.fn(), recover: vi.fn() },
}));
vi.mock("../../lib/connector-launch", () => ({
  openConnectorSession: vi.fn(),
}));
const output = vi.hoisted(() => ({ json: vi.fn() }));
vi.mock("../../lib/output", async (original) => ({
  ...(await original<typeof import("../../lib/output")>()),
  printJson: output.json,
}));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  output.json.mockClear();
});

it("uses composite discovery in the actual serve factory", async () => {
  const root = mkdtempSync("/tmp/tila-cli-factory-");
  const connector = createHostConnector(new ConnectorStore(root));
  cleanup.push(async () => {
    await connector.close();
    rmSync(root, { recursive: true, force: true });
  });
  expect(connector.discovery).toBeInstanceOf(CompositeDiscovery);
});

it("routes parsed CLI selectors through authenticated control and returns effect-free inspection and unsupported registration", async () => {
  const root = mkdtempSync("/tmp/tila-cli-herdr-");
  vi.stubEnv("TILA_HOME", root);
  const store = new ConnectorStore(join(root, "connector"));
  const discover = vi.fn(async () => {
    throw new Error("Fixture missing profile; PRIVATE-ARGV-TOKEN");
  });
  const wake = vi.fn();
  const start = vi.fn();
  const recover = vi.fn();
  const connector = new HostConnector(
    store,
    { discover, wake, close: vi.fn() },
    { start, recover },
  );
  const control = new ConnectorControl(store);
  await control.listen((request) => connector.request(request));
  cleanup.push(async () => {
    await connector.close();
    await control.close();
    rmSync(root, { recursive: true, force: true });
  });
  const args = [
    "--key",
    "a".repeat(64),
    "--socket",
    join(root, "fixture.sock"),
    "--pane",
    "w1:p1",
  ];
  await runCommand(command, { rawArgs: ["reconcile", ...args] });
  expect(discover).toHaveBeenCalledWith("a".repeat(64), undefined, {
    kind: "herdr",
    socket: join(root, "fixture.sock"),
    paneId: "w1:p1",
  });
  expect(output.json).toHaveBeenLastCalledWith(
    expect.objectContaining({ eligibility: "unavailable" }),
  );
  expect(JSON.stringify(output.json.mock.calls)).not.toContain(
    "PRIVATE-ARGV-TOKEN",
  );
  discover.mockClear();
  await runCommand(command, { rawArgs: ["reconcile"] });
  expect(output.json).toHaveBeenLastCalledWith(
    expect.objectContaining({ registrations: [] }),
  );
  expect(discover).not.toHaveBeenCalled();
  await runCommand(command, { rawArgs: ["register", ...args, "--epoch", "0"] });
  expect(output.json).toHaveBeenLastCalledWith(
    expect.objectContaining({ code: "unsupported-capability" }),
  );
  expect(discover).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
  expect(wake).not.toHaveBeenCalled();
  await expect(
    runCommand(command, { rawArgs: ["open"] }),
  ).rejects.toMatchObject({ code: "unsupported-capability" });
  expect(start).not.toHaveBeenCalled();
});

it("requires explicit selectors instead of guessing plugin context", async () => {
  await expect(
    runCommand(command, { rawArgs: ["reconcile", "--key", "a".repeat(64)] }),
  ).rejects.toThrow();
  expect(output.json).not.toHaveBeenCalled();
});
