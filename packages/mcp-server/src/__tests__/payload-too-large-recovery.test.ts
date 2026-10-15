import { McpRecoverySchema } from "@tila/schemas";
import { TilaApiError } from "tila-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toMcpError } from "../errors";
import { recoveryFor, toolFailure } from "../tool-registration";
import { registerEntityTools } from "../tools/entities";
import {
  type MockFacade,
  type MockServer,
  asFacade,
  asServer,
  createMockFacade,
  createMockServer,
  findToolHandler,
} from "./helpers/mock-facade";

/**
 * Task data past its bound is refused as `payload-too-large`. Remote clients
 * see it as an HTTP 413 `TilaApiError`; embedded and local backends raise the
 * ops layer's `TaskDataTooLargeError`, which MCP recognises by name (the
 * `@tila/ops-sqlite` class is asserted to carry this name in its own tests).
 */
class TaskDataTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskDataTooLargeError";
  }
}

const MESSAGE =
  "Task data is 262145 bytes; task data is limited to 262144 bytes (256 KiB) of JSON";

const localError = () => new TaskDataTooLargeError(MESSAGE);
const httpError = () =>
  new TilaApiError(413, "payload-too-large", MESSAGE, false);

describe("recoveryFor payload-too-large", () => {
  it.each([
    ["a local TaskDataTooLargeError", localError],
    ["an HTTP 413 TilaApiError", httpError],
  ])("gives %s a specific recovery", (_label, make) => {
    const recovery = recoveryFor(make());

    expect(recovery).toMatchObject({
      code: "payload-too-large",
      message: MESSAGE,
      retry_safety: "after_recovery",
    });
    expect(recovery.recovery_action).toMatch(/Reduce the data/);
    expect(recovery.recovery_action).toMatch(
      /same payload again cannot succeed/,
    );
    // Not the generic advice that a mutation may already have committed.
    expect(recovery.recovery_action).not.toMatch(/already have committed/);
    expect(McpRecoverySchema.safeParse(recovery).success).toBe(true);
  });

  it.each([
    ["local", localError],
    ["HTTP", httpError],
  ])("reads the %s error through the MCP wrapper tools throw", (_l, make) => {
    const wrapped = toMcpError(make());
    expect(recoveryFor(wrapped)).toMatchObject({
      code: "payload-too-large",
      retry_safety: "after_recovery",
    });
  });

  it("gives local and HTTP errors the same code, safety and action", () => {
    const { message: _local, ...local } = recoveryFor(localError());
    const { message: _http, ...http } = recoveryFor(httpError());
    expect(local).toEqual(http);
  });

  it("does not change the classification of unrelated errors", () => {
    expect(recoveryFor(new Error("boom"))).toMatchObject({
      code: "unknown",
      retry_safety: "unknown",
      recovery_action: expect.stringMatching(/already have committed/),
    });
    expect(
      recoveryFor(new TilaApiError(404, "not-found", "gone", false)),
    ).toMatchObject({ code: "not-found", retry_safety: "after_recovery" });
  });

  it("surfaces the recovery in a tool failure result", () => {
    const failure = toolFailure(localError());
    expect(failure.isError).toBe(true);
    expect(failure.structuredContent).toEqual({
      error: expect.objectContaining({
        code: "payload-too-large",
        retry_safety: "after_recovery",
      }),
    });
  });
});

describe("tila_task_create with oversized task data", () => {
  let server: MockServer;
  let facade: MockFacade;

  beforeEach(() => {
    server = createMockServer();
    facade = createMockFacade();
    registerEntityTools(asServer(server), asFacade(facade), "test-project");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["a local TaskDataTooLargeError", localError],
    ["an HTTP 413", httpError],
  ])("returns the payload-too-large recovery for %s", async (_label, make) => {
    facade.tasks.create.mockRejectedValue(make());

    const result = await findToolHandler(
      server,
      "tila_task_create",
    )({
      id: "T-big",
      type: "task",
      data: { description: "x" },
    });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "payload-too-large",
          message: expect.stringContaining("262144"),
          retry_safety: "after_recovery",
          recovery_action: expect.stringMatching(/Reduce the data/),
        },
      },
    });
  });
});
