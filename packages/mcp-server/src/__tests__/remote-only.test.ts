import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REMOTE_ONLY_TOOLS,
  guardRemoteOnlyTools,
  isRemoteOnlyTool,
  remoteOnlyError,
} from "../remote-only";
import { registerArtifactTools } from "../tools/artifacts";
import {
  type MockFacade,
  type MockServer,
  asFacade,
  asServer,
  createMockFacade,
  createMockServer,
  findToolHandler,
} from "./helpers/mock-facade";

const PROJECT_ID = "test-project";

describe("REMOTE_ONLY_TOOLS", () => {
  it("is a typed, non-empty constant containing tila_artifact_put", () => {
    expect(REMOTE_ONLY_TOOLS).toContain("tila_artifact_put");
    expect(isRemoteOnlyTool("tila_artifact_put")).toBe(true);
    expect(isRemoteOnlyTool("tila_task_create")).toBe(false);
  });

  it("remoteOnlyError carries a clear 'requires a remote backend' message", () => {
    const err = remoteOnlyError("tila_artifact_put");
    expect(err.message).toMatch(/requires a remote backend/i);
    expect(err.message).toContain("tila_artifact_put");
  });
});

describe("guardRemoteOnlyTools — local mode", () => {
  let baseServer: MockServer;
  let facade: MockFacade;

  beforeEach(() => {
    baseServer = createMockServer();
    facade = createMockFacade();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a REMOTE_ONLY tool throws the clear remote-backend error in local mode (no facade call)", async () => {
    const guarded = guardRemoteOnlyTools(asServer(baseServer), "local");
    registerArtifactTools(guarded, asFacade(facade), PROJECT_ID);

    // The tool still registers (clients can discover it)...
    const names = baseServer.tool.mock.calls.map((c: unknown[]) => c[0]);
    expect(names).toContain("tila_artifact_put");

    // ...but invoking it rejects with the clear error, and never touches the facade.
    const handler = findToolHandler(baseServer, "tila_artifact_put");
    await expect(
      handler({ content: "aGVsbG8=", kind: "log", mime_type: "text/plain" }),
    ).rejects.toThrow(/requires a remote backend/i);
    expect(facade.artifacts.upload).not.toHaveBeenCalled();
  });

  it("a local-capable tool runs normally through the facade in local mode", async () => {
    const guarded = guardRemoteOnlyTools(asServer(baseServer), "local");
    registerArtifactTools(guarded, asFacade(facade), PROJECT_ID);

    facade.artifacts.writeText.mockResolvedValue({
      ok: true,
      key: "k",
      bytes: 1,
    });

    const handler = findToolHandler(baseServer, "tila_artifact_write_text");
    await handler({ content: "hi", kind: "note", mime_type: "text/plain" });
    expect(facade.artifacts.writeText).toHaveBeenCalled();
  });
});

describe("guardRemoteOnlyTools — remote mode", () => {
  it("is a transparent pass-through (the REMOTE_ONLY tool calls the facade)", async () => {
    const baseServer = createMockServer();
    const facade = createMockFacade();
    facade.artifacts.upload.mockResolvedValue({ ok: true, key: "k", bytes: 5 });

    const guarded = guardRemoteOnlyTools(asServer(baseServer), "remote");
    registerArtifactTools(guarded, asFacade(facade), PROJECT_ID);

    const handler = findToolHandler(baseServer, "tila_artifact_put");
    await handler({
      content: "aGVsbG8=",
      kind: "log",
      mime_type: "text/plain",
    });
    expect(facade.artifacts.upload).toHaveBeenCalledTimes(1);
  });
});
