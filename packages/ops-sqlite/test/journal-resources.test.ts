import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listJournal } from "../src/journal-ops";
import { type TestDb, createEntity, createTestDb } from "./helpers";

let testDb: TestDb;
beforeEach(() => {
  testDb = createTestDb();
});
afterEach(() => {
  testDb.rawDb.close();
});

describe("listJournal with several resources", () => {
  it("returns events for every listed resource, newest first", () => {
    createEntity(testDb.db, { id: "a" });
    createEntity(testDb.db, { id: "b" });
    createEntity(testDb.db, { id: "c" });

    const events = listJournal(testDb.db, { resource: ["a", "c"] });
    expect(events.map((e) => e.resource)).toEqual(["c", "a"]);
    expect(
      listJournal(testDb.db, { resource: "b" }).map((e) => e.resource),
    ).toEqual(["b"]);
  });
});
