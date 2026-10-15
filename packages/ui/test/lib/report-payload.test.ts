import { reportPayloadFields } from "@/lib/report-payload";
import { describe, expect, it } from "vitest";

/** The journal event's `data` is the append request; the payload is `data.data`. */
const report = (payload: unknown, outer: Record<string, unknown> = {}) => ({
  event_name: "pipeline.tests_passed",
  event_version: 1,
  target: { kind: "project" },
  ...outer,
  data: payload,
});

describe("reportPayloadFields", () => {
  it("renders top-level string fields as markdown, in payload order", () => {
    const fields = reportPayloadFields(
      report({ summary: "# Done\n\n- one", notes: "plain **text**" }),
    );
    expect(fields.map((f) => [f.key, f.kind])).toEqual([
      ["summary", "markdown"],
      ["notes", "markdown"],
    ]);
    expect(fields[0]).toMatchObject({
      html: expect.stringContaining("<h1>Done</h1>"),
    });
    expect(fields[1]).toMatchObject({
      html: expect.stringContaining("<strong>text</strong>"),
    });
  });

  it("uses the payload, not the outer report metadata", () => {
    const fields = reportPayloadFields(
      report(
        { detail: "payload text" },
        {
          event_name: "metadata.name",
          correlation_id: "run-1",
          occurred_at: "2026-01-01T00:00:00Z",
          artifact_refs: ["a/b"],
        },
      ),
    );
    expect(fields.map((f) => f.key)).toEqual(["detail"]);
  });

  it("shows every non-string value verbatim as JSON text, never dropping it", () => {
    const fields = reportPayloadFields(
      report({
        count: 3,
        ok: false,
        nothing: null,
        steps: ["build", "test"],
        nested: { notes: "# not rendered", depth: { n: 1 } },
        label: "# rendered",
      }),
    );
    expect(fields.map((f) => [f.key, f.kind])).toEqual([
      ["count", "json"],
      ["ok", "json"],
      ["nothing", "json"],
      ["steps", "json"],
      ["nested", "json"],
      ["label", "markdown"],
    ]);
    const text = (key: string) => {
      const field = fields.find((f) => f.key === key);
      return field?.kind === "json" ? field.text : undefined;
    };
    expect(text("count")).toBe("3");
    expect(text("ok")).toBe("false");
    expect(text("nothing")).toBe("null");
    expect(JSON.parse(text("steps") ?? "")).toEqual(["build", "test"]);
    // Strings inside a nested value stay text: only top-level strings are
    // interpreted as markdown.
    expect(JSON.parse(text("nested") ?? "")).toEqual({
      notes: "# not rendered",
      depth: { n: 1 },
    });
  });

  it("keeps blank strings visible as an empty value instead of hiding the field", () => {
    const fields = reportPayloadFields(report({ empty: "", spaces: "  \n " }));
    expect(fields).toEqual([
      { key: "empty", kind: "json", text: '""' },
      { key: "spaces", kind: "json", text: '"  \\n "' },
    ]);
  });

  it("yields nothing when there is no object payload", () => {
    expect(reportPayloadFields(report({}))).toEqual([]);
    expect(reportPayloadFields(report(null))).toEqual([]);
    expect(reportPayloadFields(report(["a", "b"]))).toEqual([]);
    expect(reportPayloadFields(report("text"))).toEqual([]);
    expect(reportPayloadFields({ event_name: "x.y" })).toEqual([]);
    expect(reportPayloadFields({})).toEqual([]);
  });

  it("keeps hostile keys and values as inert data", () => {
    const fields = reportPayloadFields(
      report({
        "<img src=x onerror=alert(1)>": "<script>alert(1)</script>",
      }),
    );
    // Keys are labels for the caller to escape as text; they are never HTML.
    expect(fields[0].key).toBe("<img src=x onerror=alert(1)>");
    expect(fields[0]).toMatchObject({ kind: "markdown" });
    const html = fields[0].kind === "markdown" ? fields[0].html : "";
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });

  it("treats a JSON __proto__ key as an ordinary field", () => {
    // JSON.parse creates a real own property, unlike an object literal.
    const payload = JSON.parse('{"__proto__": "own **property**", "b": 1}');
    const fields = reportPayloadFields(report(payload));
    expect(fields.map((f) => f.key)).toEqual(["__proto__", "b"]);
    expect(fields[0]).toMatchObject({
      kind: "markdown",
      html: expect.stringContaining("<strong>property</strong>"),
    });
  });
});
