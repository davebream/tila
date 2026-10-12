import { expect, test } from "bun:test";
import { makeHarness } from "./harness.bun";

test("embedded catalogs list declared empty types and undeclared in-use types", async () => {
  const h = makeHarness();
  try {
    await h.project.applySchema({
      definition: `schema_version = 1

[work_units.story]
fields = [{ name = "headline", type = "string" }]
presentation = { title = "headline" }

[work_units.spike]
`,
    });
    await h.project.create({
      id: "s-1",
      type: "story",
      data: { headline: "Ship it" },
      created_by: "cli",
    });

    const work = await h.project.workCatalog();
    expect(work.types.map((t) => [t.type, t.declaration, t.count])).toEqual([
      ["spike", "declared", 0],
      ["story", "declared", 1],
    ]);
    expect(work.types[1].definition?.presentation).toEqual({
      title: "headline",
    });
    expect(work.scope).toEqual({ restricted: false });

    const records = h.project.recordCatalog();
    expect(records.types).toEqual([]);
  } finally {
    h.close();
  }
});
