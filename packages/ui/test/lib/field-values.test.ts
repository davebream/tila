import { changedData, fromRaw, rawFields } from "@/lib/field-values";
import type { CatalogField } from "@tila/schemas";

const fields: CatalogField[] = [
  { name: "title", type: "string", required: true },
  {
    name: "severity",
    type: "enum",
    required: false,
    values: ["low", "high"],
    default: "low",
  },
  { name: "labels", type: "list<string>", required: false },
  { name: "estimate", type: "number", required: false },
  { name: "blocking", type: "boolean", required: false },
  { name: "meta", type: "json", required: false },
];

test("new rows start from declared defaults; stored rows from their values", () => {
  expect(rawFields(fields, null)).toMatchObject({ title: "", severity: "low" });
  expect(
    rawFields(fields, { title: "x", labels: ["a", "b"], meta: { k: 1 } }),
  ).toMatchObject({
    title: "x",
    severity: "",
    labels: "a\nb",
    meta: '{\n  "k": 1\n}',
  });
});

test("converts inputs to declared types and reports every invalid field", () => {
  expect(
    fromRaw(fields, {
      title: "Fix",
      severity: "high",
      labels: "a\n\n b ",
      estimate: "2.5",
      blocking: "true",
      meta: '{"k":1}',
    }),
  ).toEqual({
    ok: true,
    data: {
      title: "Fix",
      severity: "high",
      labels: ["a", "b"],
      estimate: 2.5,
      blocking: true,
      meta: { k: 1 },
    },
  });
  const bad = fromRaw(fields, {
    title: " ",
    severity: "urgent",
    estimate: "many",
    meta: "{",
  });
  expect(bad).toEqual({
    ok: false,
    errors: {
      title: "Required.",
      severity: "Choose one of: low, high.",
      estimate: "Enter a number.",
      meta: "Enter valid JSON.",
    },
  });
});

test("clearing a stored optional field sends null so a merge update removes it", () => {
  const result = fromRaw(
    fields,
    { title: "x", severity: "" },
    { previous: { title: "x", severity: "high" } },
  );
  expect(result).toEqual({ ok: true, data: { title: "x", severity: null } });
});

test("skipped fields are neither validated nor sent", () => {
  expect(fromRaw(fields, {}, { skip: new Set(["title"]) })).toEqual({
    ok: true,
    data: {},
  });
});

test("changedData keeps only keys whose stored value differs", () => {
  expect(
    changedData(
      { title: "x", severity: null, labels: ["a"] },
      { title: "x", labels: ["b"] },
    ),
  ).toEqual({ labels: ["a"] });
});
