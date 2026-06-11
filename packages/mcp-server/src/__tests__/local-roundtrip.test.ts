/**
 * Local-backend round-trip: proves the MCP tools work against the REAL embedded
 * SQLite stack (`tila-sdk/local` → better-sqlite3 + node:fs) under plain node —
 * no HTTP, no mocks of the data layer.
 *
 * RED→GREEN driver for Task 12: with `backend: "local"`, `tila_task_create`
 * then `tila_task_list` round-trip through the local store, and a
 * REMOTE_ONLY_TOOLS tool (`tila_artifact_put`) throws the clear remote-backend
 * error under the local guard.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TilaProjectConfig } from "@tila/schemas";
import { type TilaFacade, createTila } from "tila-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guardRemoteOnlyTools } from "../remote-only";
import { registerAllTools } from "../tools/index";
import {
  type MockServer,
  asServer,
  createMockServer,
  findToolHandler,
} from "./helpers/mock-facade";

const PROJECT_ID = "local-roundtrip-proj";

describe("MCP tools — local backend round-trip (real tila-sdk/local under node)", () => {
  let tmp: string;
  let facade: TilaFacade;
  let server: MockServer;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "tila-mcp-local-"));
    const config: TilaProjectConfig = {
      project_id: PROJECT_ID,
      backend: "local",
      local: {
        db_path: join(tmp, "tila.db"),
        artifacts_path: join(tmp, "artifacts"),
        org: "test-org",
      },
      schema_version: 0,
      tila_version: "0.0.0",
      created_at: new Date(0).toISOString(),
    };
    facade = await createTila(config);

    server = createMockServer();
    const guarded = guardRemoteOnlyTools(asServer(server), "local");
    registerAllTools(guarded, facade, PROJECT_ID);
  });

  afterAll(() => {
    facade?.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("creates a task then lists it through the local store (no HTTP)", async () => {
    const createHandler = findToolHandler(server, "tila_task_create");
    const created = await createHandler({
      id: "T-1",
      type: "task",
      data: { title: "Local round-trip" },
    });
    const createdParsed = JSON.parse(created.content[0].text);
    expect(createdParsed.ok).toBe(true);
    expect(createdParsed.entity.id).toBe("T-1");

    const listHandler = findToolHandler(server, "tila_task_list");
    const listed = await listHandler({});
    const listedParsed = JSON.parse(listed.content[0].text);
    expect(listedParsed.ok).toBe(true);
    const ids = listedParsed.entities.map((e: { id: string }) => e.id);
    expect(ids).toContain("T-1");
  });

  it("rejects the REMOTE_ONLY tila_artifact_put with the clear remote-backend error", async () => {
    const handler = findToolHandler(server, "tila_artifact_put");
    await expect(
      handler({ content: "aGVsbG8=", kind: "log", mime_type: "text/plain" }),
    ).rejects.toThrow(/requires a remote backend/i);
  });

  it("write/read text artifact works locally (a local-capable artifact path)", async () => {
    const writeHandler = findToolHandler(server, "tila_artifact_write_text");
    const wrote = await writeHandler({
      content: "# hello local",
      kind: "note",
      mime_type: "text/markdown",
    });
    const wroteParsed = JSON.parse(wrote.content[0].text);
    expect(wroteParsed.ok).toBe(true);
    expect(typeof wroteParsed.key).toBe("string");

    const readHandler = findToolHandler(server, "tila_artifact_read_text");
    const read = await readHandler({ key: wroteParsed.key });
    expect(read.content[0].text).toContain("hello local");
  });
});
