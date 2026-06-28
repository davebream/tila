import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Hoisted mocks (avoid TDZ since vi.mock factories are hoisted) ---

const { mockGetCurrentContext, mockRunMcpInit } = vi.hoisted(() => {
  const mockGetCurrentContext = vi.fn();
  const mockRunMcpInit = vi.fn();
  return { mockGetCurrentContext, mockRunMcpInit };
});

vi.mock("@tila/auth-store", () => ({
  // Use regular functions so they can be called with `new`
  AuthStore: vi.fn(function (this: unknown) {
    return { getCurrentContext: mockGetCurrentContext };
  }),
  TilaPaths: vi.fn(function (this: unknown) {
    return {};
  }),
  KeyringSecretStore: vi.fn(function (this: unknown) {
    return {};
  }),
  processEnvProbe: { isCI: false, isTTY: true },
}));

vi.mock("../../lib/mcp-targets", () => ({
  TARGET_DEFS: [
    {
      slug: "claude-code",
      configPath: ".mcp.json",
      topLevelKey: "mcpServers",
      printSnippetOnly: false,
      detectionPaths: [".mcp.json"],
    },
  ],
  runMcpInit: mockRunMcpInit,
}));

vi.mock("@clack/prompts", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
    message: vi.fn(),
  },
  isCancel: vi.fn().mockReturnValue(false),
  confirm: vi.fn().mockResolvedValue(true),
  note: vi.fn(),
  select: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

// Now import the SUT after all mocks are registered
import mcpCommand from "../../commands/mcp";

type InitSubCommand = {
  run: (ctx: {
    args: Record<string, unknown>;
    rawArgs: string[];
  }) => Promise<void>;
};

async function invokeInit(
  rawArgs: string[] = [],
  args: Record<string, unknown> = {},
) {
  const initCmd = (
    mcpCommand as unknown as {
      subCommands: Record<string, InitSubCommand>;
    }
  ).subCommands.init;
  await initCmd.run({ args: { "dry-run": false, ...args }, rawArgs });
}

describe("mcp init command — instanceKey resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunMcpInit.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes instanceKey to runMcpInit when getCurrentContext resolves with a key", async () => {
    mockGetCurrentContext.mockResolvedValue("inst-abc123");

    await invokeInit();

    expect(mockRunMcpInit).toHaveBeenCalledOnce();
    const callArgs = mockRunMcpInit.mock.calls[0] as [Record<string, unknown>];
    expect(callArgs[0].instanceKey).toBe("inst-abc123");
  });

  it("R4 degradation: passes instanceKey: undefined when getCurrentContext rejects (not logged in)", async () => {
    // Simulate the user not being logged in — getCurrentContext rejects
    mockGetCurrentContext.mockRejectedValue(new Error("keychain unavailable"));

    await invokeInit();

    expect(mockRunMcpInit).toHaveBeenCalledOnce();
    const callArgs = mockRunMcpInit.mock.calls[0] as [Record<string, unknown>];
    // Degradation: falls back to undefined → legacy TILA_API_TOKEN placeholder mode
    expect(callArgs[0].instanceKey).toBeUndefined();
  });

  it("R4 degradation: passes instanceKey: undefined when getCurrentContext resolves null (no context set)", async () => {
    mockGetCurrentContext.mockResolvedValue(null);

    await invokeInit();

    expect(mockRunMcpInit).toHaveBeenCalledOnce();
    const callArgs = mockRunMcpInit.mock.calls[0] as [Record<string, unknown>];
    // null ?? undefined → undefined
    expect(callArgs[0].instanceKey).toBeUndefined();
  });
});
