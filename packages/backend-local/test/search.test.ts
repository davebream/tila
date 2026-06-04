import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalProject } from "../src/local-project";

describe("LocalProject FTS5 search", () => {
  let tempDir: string;
  let project: LocalProject;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tila-search-test-"));
    const dbPath = join(tempDir, "test.db");
    project = LocalProject.open(dbPath, "test-org", "test-project", {
      skipFilesystemCheck: true,
    });
  });

  afterEach(() => {
    project.close();
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("searchEntities finds created entities", async () => {
    await project.create({
      id: "e1",
      type: "task",
      data: { name: "Deploy pipeline" },
      created_by: "test",
    });
    const results = project.searchEntities({ q: "deploy" });
    expect(results.length).toBe(1);
    expect(results[0].entity_id).toBe("e1");
    expect(results[0].name).toBe("Deploy pipeline");
  });

  it("searchEntities returns empty for no matches", async () => {
    await project.create({
      id: "e2",
      type: "task",
      data: { name: "Something else" },
      created_by: "test",
    });
    const results = project.searchEntities({ q: "nonexistent" });
    expect(results.length).toBe(0);
  });

  it("searchAll returns mixed results with type field", async () => {
    await project.create({
      id: "e3",
      type: "task",
      data: { name: "Search test entity" },
      created_by: "test",
    });
    const results = project.searchAll({ q: "search" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    const entityResult = results.find((r) => r.type === "entity");
    expect(entityResult).toBeTruthy();
    expect(entityResult?.entity_id).toBe("e3");
  });

  it("searchEntities reflects updates to entity name", async () => {
    await project.create({
      id: "e4",
      type: "task",
      data: { name: "Original name" },
      created_by: "test",
    });
    // Update the entity name via LocalProject.update (which handles claim internally)
    await project.update("e4", { name: "Updated name" });
    const found = project.searchEntities({ q: "updated" });
    expect(found.length).toBe(1);
    expect(found[0].name).toBe("Updated name");
    const notFound = project.searchEntities({ q: "original" });
    expect(notFound.length).toBe(0);
  });

  it("searchEntities removes archived entities from results", async () => {
    await project.create({
      id: "e5",
      type: "task",
      data: { name: "Archivable entity" },
      created_by: "test",
    });
    await project.archive("e5");
    const results = project.searchEntities({ q: "archivable" });
    expect(results.length).toBe(0);
  });
});
