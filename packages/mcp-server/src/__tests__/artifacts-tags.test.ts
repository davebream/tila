import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("registerArtifactTools — tags", () => {
  let server: MockServer;
  let facade: MockFacade;

  beforeEach(() => {
    server = createMockServer();
    facade = createMockFacade();
    registerArtifactTools(asServer(server), asFacade(facade), PROJECT_ID);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const findHandler = (name: string) => findToolHandler(server, name);

  it("tila_artifact_put schema includes an optional tags field", () => {
    const putCall = server.tool.mock.calls.find(
      (c: unknown[]) => c[0] === "tila_artifact_put",
    );
    if (!putCall) throw new Error("tila_artifact_put not found");
    const schema = putCall[2] as Record<string, unknown>;
    expect(schema).toHaveProperty("tags");
  });

  it("tila_artifact_put passes tags to artifacts.upload when provided", async () => {
    facade.artifacts.upload.mockResolvedValue({
      ok: true,
      key: "sources/abc.txt",
      bytes: 5,
      deduplicated: false,
    });

    const handler = findHandler("tila_artifact_put");
    // base64 for "hello"
    await handler({
      content: "aGVsbG8=",
      kind: "log",
      mime_type: "text/plain",
      tags: ["team:eng", "env:prod"],
    });

    const opts = facade.artifacts.upload.mock.calls[0][1] as {
      tags?: string[];
    };
    expect(opts.tags).toEqual(["team:eng", "env:prod"]);
  });

  it("tila_artifact_put passes undefined tags when not provided", async () => {
    facade.artifacts.upload.mockResolvedValue({ ok: true });

    const handler = findHandler("tila_artifact_put");
    await handler({
      content: "aGVsbG8=",
      kind: "log",
      mime_type: "application/octet-stream",
    });

    const opts = facade.artifacts.upload.mock.calls[0][1] as {
      tags?: string[];
    };
    expect(opts.tags).toBeUndefined();
  });

  it("tila_artifact_write_text schema includes an optional tags field", () => {
    const writeCall = server.tool.mock.calls.find(
      (c: unknown[]) => c[0] === "tila_artifact_write_text",
    );
    if (!writeCall) throw new Error("tila_artifact_write_text not found");
    const schema = writeCall[2] as Record<string, unknown>;
    expect(schema).toHaveProperty("tags");
  });

  it("tila_artifact_write_text passes tags to artifacts.writeText when provided", async () => {
    facade.artifacts.writeText.mockResolvedValue({
      ok: true,
      key: "sources/abc.md",
      bytes: 12,
    });

    const handler = findHandler("tila_artifact_write_text");
    await handler({
      content: "# My Plan",
      kind: "plan",
      mime_type: "text/markdown",
      tags: ["repo:api"],
    });

    const opts = facade.artifacts.writeText.mock.calls[0][1] as {
      tags?: string[];
    };
    expect(opts.tags).toEqual(["repo:api"]);
  });

  it("tila_artifact_write_text omits tags when not provided", async () => {
    facade.artifacts.writeText.mockResolvedValue({ ok: true });

    const handler = findHandler("tila_artifact_write_text");
    await handler({ content: "x", kind: "log", mime_type: "text/plain" });

    const opts = facade.artifacts.writeText.mock.calls[0][1] as {
      tags?: string[];
    };
    expect(opts.tags).toBeUndefined();
  });
});
