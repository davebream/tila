import { describe, expect, it } from "vitest";
import { TilaSchemaTomlSchema } from "../src/config";
import { presentedText, presentedTitle } from "../src/presentation";

const base = { schema_version: 1 };

describe("schema presentation metadata", () => {
  it("accepts presentation slots that reference declared text fields", () => {
    const parsed = TilaSchemaTomlSchema.safeParse({
      ...base,
      work_units: {
        story: {
          fields: {
            headline: { type: "string" },
            body: { type: "text" },
            stage: { type: "enum", values: ["a", "b"] },
          },
          presentation: {
            title: "headline",
            description: "body",
            summary: "stage",
          },
        },
      },
      records: {
        runbook: {
          fields: { label: { type: "string" } },
          presentation: { title: "label", kind: "content" },
        },
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.work_units.story.presentation?.title).toBe("headline");
    expect(parsed.data.records.runbook.presentation?.kind).toBe("content");
  });

  it("rejects a presentation slot that names an undeclared field", () => {
    const parsed = TilaSchemaTomlSchema.safeParse({
      ...base,
      work_units: {
        story: {
          fields: { name: { type: "string" } },
          presentation: { title: "headline" },
        },
      },
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain(
      "presentation.title must reference a declared string, text, or enum field",
    );
  });

  it("rejects a presentation slot that names a non-text field", () => {
    const parsed = TilaSchemaTomlSchema.safeParse({
      ...base,
      records: {
        limits: {
          fields: { max: { type: "number" } },
          presentation: { title: "max" },
        },
      },
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts record presentation when fields come from an external schema_ref", () => {
    const parsed = TilaSchemaTomlSchema.safeParse({
      ...base,
      records: {
        deploy: {
          schema_ref: "deploy.json",
          presentation: { title: "service", kind: "configuration" },
        },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown record kind", () => {
    const parsed = TilaSchemaTomlSchema.safeParse({
      ...base,
      records: { deploy: { presentation: { kind: "settings" } } },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("presentedTitle", () => {
  it("uses the declared title field and never falls back past it", () => {
    expect(
      presentedTitle(
        { headline: "Ship it", title: "x" },
        { title: "headline" },
      ),
    ).toBe("Ship it");
    expect(presentedTitle({ title: "x" }, { title: "headline" })).toBeNull();
    expect(
      presentedTitle({ headline: "  " }, { title: "headline" }),
    ).toBeNull();
  });

  it("falls back to title then name without presentation metadata", () => {
    expect(presentedTitle({ title: "A", name: "B" })).toBe("A");
    expect(presentedTitle({ name: "B" })).toBe("B");
    expect(presentedTitle({ title: 3, name: "" })).toBeNull();
    expect(presentedTitle(null)).toBeNull();
  });

  it("presentedText reads only the named field", () => {
    expect(presentedText({ body: "x" }, "body")).toBe("x");
    expect(presentedText({ body: "x" }, undefined)).toBeNull();
    expect(presentedText({ body: 1 }, "body")).toBeNull();
  });
});
