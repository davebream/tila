import { claimResourceMatchesEntity } from "@/pages/task-detail";

describe("claimResourceMatchesEntity", () => {
  test("canonical task form matches the bare entity id", () => {
    expect(
      claimResourceMatchesEntity(
        "task:task.ingest-worker",
        "task.ingest-worker",
        "task",
      ),
    ).toBe(true);
  });

  test("canonical epic form matches the bare entity id", () => {
    expect(claimResourceMatchesEntity("epic:e1", "e1", "epic")).toBe(true);
  });

  test("bare resource matches the bare entity id", () => {
    expect(
      claimResourceMatchesEntity(
        "task.ingest-worker",
        "task.ingest-worker",
        "task",
      ),
    ).toBe(true);
  });

  test("entity type present with a bare resource matches (OR-4 tolerance)", () => {
    expect(claimResourceMatchesEntity("e1", "e1", "epic")).toBe(true);
  });

  test("a different id does not match", () => {
    expect(
      claimResourceMatchesEntity("task:other", "task.ingest-worker", "task"),
    ).toBe(false);
  });

  test("undefined entity type falls back to bare-only — typed resource does not match", () => {
    expect(claimResourceMatchesEntity("task:x", "x", undefined)).toBe(false);
  });

  test("undefined entity type falls back to bare-only — bare resource matches", () => {
    expect(claimResourceMatchesEntity("x", "x", undefined)).toBe(true);
  });

  test("empty entityId never matches", () => {
    expect(claimResourceMatchesEntity("task:", "", "task")).toBe(false);
  });

  test("empty resource never matches", () => {
    expect(claimResourceMatchesEntity("", "x", "task")).toBe(false);
  });

  test("a record resource sharing the trailing id does not collide", () => {
    expect(
      claimResourceMatchesEntity(
        "record:foo/task.ingest-worker",
        "task.ingest-worker",
        "task",
      ),
    ).toBe(false);
  });
});
