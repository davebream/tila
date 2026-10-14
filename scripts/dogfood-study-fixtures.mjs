/**
 * Scenario fixtures for the #194 dogfood pilot.
 *
 * Generates, deterministically, the disposable repositories, frozen acceptance
 * cases, reference solutions, fact sheets and worker packets for two matched
 * task pairs (p1 "report", p2 "commands"), each with variants x and y.
 *
 * Nothing here runs an agent. The acceptance cases, reference solutions and fact
 * sheets are hashed into the manifest and are never written into a worktree.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const PAIRS = ["p1", "p2"];
export const VARIANTS = ["x", "y"];
export const DECISION_ID = "D1";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** Stable JSON: object keys sorted recursively so hashes do not depend on insertion order. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Template p1: report. Two report functions share one new amount formatter.
// ---------------------------------------------------------------------------

const REPORT = {
  x: {
    entity: "invoice",
    plural: "invoices",
    group: "customer",
    note: "note",
    symbol: "$",
    dataFile: "src/ledger.mjs",
    helperFile: "src/money.mjs",
    helperFn: "formatMoney",
    item1File: "src/summary.mjs",
    item1Fn: "summarize",
    item2File: "src/detail.mjs",
    item2Fn: "describe",
    header: (n, plural) => `Summary (${n} ${plural})`,
    line: (g, m, c) => `${g}: ${m} (${c})`,
    totalLabel: "Total",
    detail1: (r, g, n) => `${r.id} | ${r[g]} | ${r[n]}`,
    amountLabel: "Amount",
    unknown: (id) => `unknown invoice: ${id}`,
    rows: [
      ["INV-101", "acme", "annual plan", 125000],
      ["INV-102", "birch", "credit for outage", -4250],
      ["INV-103", "acme", "support hours", 9999],
      ["INV-104", "corvid", "setup fee", 100],
      ["INV-105", "birch", "refund", -100000],
      ["INV-106", "acme", "promo", 0],
    ],
    idPrefix: "INV-",
  },
  y: {
    entity: "expense",
    plural: "expenses",
    group: "team",
    note: "memo",
    symbol: "€",
    dataFile: "src/spend.mjs",
    helperFile: "src/cost.mjs",
    helperFn: "formatCost",
    item1File: "src/rollup.mjs",
    item1Fn: "rollup",
    item2File: "src/lineitem.mjs",
    item2Fn: "lineItem",
    header: (n, plural) => `Rollup of ${n} ${plural}`,
    line: (g, m, c) => `${g} - ${m} x${c}`,
    totalLabel: "Grand total",
    detail1: (r, g, n) => `[${r.id}] ${r[g]}: ${r[n]}`,
    amountLabel: "Cost",
    unknown: (id) => `no such expense: ${id}`,
    rows: [
      ["EXP-31", "ops", "cloud hosting", 240050],
      ["EXP-32", "ops", "vendor refund", -15075],
      ["EXP-33", "design", "stock photos", 4900],
      ["EXP-34", "legal", "filing fee", 12500],
      ["EXP-35", "design", "licence reversal", -250000],
      ["EXP-36", "ops", "tea", 0],
    ],
    idPrefix: "EXP-",
  },
};

function toRecords(spec) {
  return spec.rows.map(([id, group, note, cents]) => ({
    id,
    [spec.group]: group,
    [spec.note]: note,
    cents,
  }));
}

/** Money rendering under the original (D0) or amended (D1) decision. */
function money(spec, cents, amended) {
  const abs = Math.abs(cents);
  const major = Math.floor(abs / 100);
  const minor = String(abs % 100).padStart(2, "0");
  const digits = amended
    ? String(major).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    : String(major);
  const body = `${spec.symbol}${digits}.${minor}`;
  if (cents < 0) return amended ? `(${body})` : `-${body}`;
  return body;
}

function reportSummary(spec, rows, amended) {
  const groups = new Map();
  let total = 0;
  for (const r of rows) {
    const g = r[spec.group];
    const cur = groups.get(g) ?? { cents: 0, count: 0 };
    cur.cents += r.cents;
    cur.count += 1;
    groups.set(g, cur);
    total += r.cents;
  }
  const lines = [spec.header(rows.length, spec.plural)];
  for (const g of [...groups.keys()].sort()) {
    const { cents, count } = groups.get(g);
    lines.push(spec.line(g, money(spec, cents, amended), count));
  }
  lines.push(`${spec.totalLabel}: ${money(spec, total, amended)}`);
  return lines.join("\n");
}

function reportDetail(spec, rows, id, amended) {
  const r = rows.find((row) => row.id === id);
  if (!r) return { throws: { name: "RangeError", message: spec.unknown(id) } };
  return {
    equals: [
      spec.detail1(r, spec.group, spec.note),
      `${spec.amountLabel}: ${money(spec, r.cents, amended)}`,
    ].join("\n"),
  };
}

function reportCases(spec, amended) {
  const rows = toRecords(spec);
  const d0 = (fn) => fn(false);
  const d1 = (fn) => fn(true);
  const mk = (name, base, file, fn, args, expectFor) => {
    const e0 = d0(expectFor);
    const e1 = d1(expectFor);
    const differs = JSON.stringify(e0) !== JSON.stringify(e1);
    return {
      name,
      tags: differs ? [...base, DECISION_ID] : base,
      kind: "call",
      file,
      fn,
      args,
      expect: amended ? e1 : e0,
    };
  };
  const sum = (subset) => (a) => ({ equals: reportSummary(spec, subset, a) });
  const det = (id) => (a) => reportDetail(spec, rows, id, a);
  const fmt = (cents) => (a) => ({ equals: money(spec, cents, a) });
  const cases = [
    mk(
      "summary of every row",
      ["item1"],
      spec.item1File,
      spec.item1Fn,
      [rows],
      sum(rows),
    ),
    mk(
      "summary of a refund-only subset",
      ["item1"],
      spec.item1File,
      spec.item1Fn,
      [[rows[1], rows[4]]],
      sum([rows[1], rows[4]]),
    ),
    mk(
      "summary of no rows",
      ["item1"],
      spec.item1File,
      spec.item1Fn,
      [[]],
      sum([]),
    ),
  ];
  for (const r of [rows[0], rows[1], rows[5]]) {
    cases.push(
      mk(
        `detail of ${r.id}`,
        ["item2"],
        spec.item2File,
        spec.item2Fn,
        [rows, r.id],
        det(r.id),
      ),
    );
  }
  cases.push(
    mk(
      "detail of an unknown id",
      ["item2"],
      spec.item2File,
      spec.item2Fn,
      [rows, `${spec.idPrefix}000`],
      det(`${spec.idPrefix}000`),
    ),
  );
  for (const cents of [0, 5, 99999, 123456, -1250, -100000]) {
    cases.push(
      mk(
        `helper renders ${cents}`,
        ["x"],
        spec.helperFile,
        spec.helperFn,
        [cents],
        fmt(cents),
      ),
    );
  }
  return cases;
}

function reportTree(spec, key) {
  const rows = toRecords(spec);
  const files = {};
  files["package.json"] = `${JSON.stringify(
    {
      name: `study-fixture-${key}`,
      private: true,
      type: "module",
      scripts: { test: "node --test test/" },
    },
    null,
    2,
  )}\n`;
  files[spec.dataFile] = [
    "// Sample data. Amounts are integers in minor units (cents).",
    `export const rows = ${JSON.stringify(rows, null, 2)};`,
    "",
    "export function findRow(id) {",
    "  return rows.find((row) => row.id === id);",
    "}",
    "",
  ].join("\n");
  files[spec.helperFile] = [
    "// Shared rendering helpers.",
    `// ${spec.helperFn}(cents) is NOT implemented yet; both work items need it.`,
    "",
    "export function padLeft(text, width) {",
    '  return String(text).padStart(width, " ");',
    "}",
    "",
  ].join("\n");
  files[spec.item1File] = [
    `export function ${spec.item1Fn}(rows) {`,
    '  throw new Error("not implemented");',
    "}",
    "",
  ].join("\n");
  files[spec.item2File] = [
    `export function ${spec.item2Fn}(rows, id) {`,
    '  throw new Error("not implemented");',
    "}",
    "",
  ].join("\n");
  const mods = [spec.dataFile, spec.helperFile, spec.item1File, spec.item2File];
  files["src/index.mjs"] = `${mods
    .map((m) => `export * from "./${m.slice("src/".length)}";`)
    .join("\n")}\n`;
  files["test/smoke.test.mjs"] = [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'import * as api from "../src/index.mjs";',
    "",
    'test("public surface is exported", () => {',
    `  assert.equal(typeof api.${spec.item1Fn}, "function");`,
    `  assert.equal(typeof api.${spec.item2Fn}, "function");`,
    '  assert.equal(typeof api.padLeft, "function");',
    "});",
    "",
  ].join("\n");
  files["NOTES.md"] = reportNotes(spec);
  return files;
}

function reportNotes(spec) {
  const sample = money(spec, -1250, false);
  return [
    "# Project notes",
    "",
    `Small library that renders ${spec.plural}. Run the visible tests with \`node --test test/\`.`,
    "",
    "## Layout",
    "",
    `- \`${spec.dataFile}\`: sample ${spec.plural}. Do not edit.`,
    `- \`${spec.helperFile}\`: shared rendering helpers. \`${spec.helperFn}(cents)\` is missing and must exist exactly once.`,
    `- \`${spec.item1File}\`: \`${spec.item1Fn}(rows)\` (work item 1).`,
    `- \`${spec.item2File}\`: \`${spec.item2Fn}(rows, id)\` (work item 2).`,
    "- `src/index.mjs`: re-exports every module.",
    "",
    "## Decision D0 (original)",
    "",
    `Amounts are integers in minor units. \`${spec.helperFn}(cents)\` renders \`<symbol><major>.<minor>\`, with no grouping separator, and a negative amount gets a leading minus before the symbol, for example \`${sample}\`.`,
    "",
    "## Working agreement",
    "",
    "- One branch per worker, named after its role. Commit your own work; never rewrite another branch.",
    "- Do not edit the data module, this file or existing tests.",
    "",
  ].join("\n");
}

function reportReference(spec, amended) {
  const grouping = amended
    ? '  const digits = String(major).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");'
    : "  const digits = String(major);";
  const negative = amended ? "`(${body})`" : "`-${body}`";
  const helper = [
    "export function padLeft(text, width) {",
    '  return String(text).padStart(width, " ");',
    "}",
    "",
    `export function ${spec.helperFn}(cents) {`,
    "  const abs = Math.abs(cents);",
    "  const major = Math.floor(abs / 100);",
    '  const minor = String(abs % 100).padStart(2, "0");',
    grouping,
    `  const body = \`${spec.symbol}\${digits}.\${minor}\`;`,
    `  return cents < 0 ? ${negative} : body;`,
    "}",
    "",
  ].join("\n");
  const g = spec.group;
  const item1 = [
    `import { ${spec.helperFn} } from "./${spec.helperFile.slice(4)}";`,
    "",
    `export function ${spec.item1Fn}(rows) {`,
    "  const groups = new Map();",
    "  let total = 0;",
    "  for (const r of rows) {",
    `    const cur = groups.get(r.${g}) ?? { cents: 0, count: 0 };`,
    "    cur.cents += r.cents;",
    "    cur.count += 1;",
    `    groups.set(r.${g}, cur);`,
    "    total += r.cents;",
    "  }",
    `  const lines = [${JSON.stringify(spec.header("@@", spec.plural)).replace("@@", '" + rows.length + "')}];`,
    "  for (const key of [...groups.keys()].sort()) {",
    "    const { cents, count } = groups.get(key);",
    `    lines.push(${lineExpression(spec, "key", `${spec.helperFn}(cents)`, "count")});`,
    "  }",
    `  lines.push(\`${spec.totalLabel}: \${${spec.helperFn}(total)}\`);`,
    '  return lines.join("\\n");',
    "}",
    "",
  ].join("\n");
  const item2 = [
    `import { ${spec.helperFn} } from "./${spec.helperFile.slice(4)}";`,
    "",
    `export function ${spec.item2Fn}(rows, id) {`,
    "  const r = rows.find((row) => row.id === id);",
    `  if (!r) throw new RangeError(${unknownExpression(spec)});`,
    `  return [${detailExpression(spec)}, \`${spec.amountLabel}: \${${spec.helperFn}(r.cents)}\`].join("\\n");`,
    "}",
    "",
  ].join("\n");
  return {
    helper: { [spec.helperFile]: helper },
    item1: { [spec.item1File]: item1 },
    item2: { [spec.item2File]: item2 },
  };
}

function lineExpression(spec, groupVar, moneyExpr, countVar) {
  // Render the variant's line template as a JS template literal.
  const probe = spec.line("@G", "@M", 0).replace("0", "@C");
  return `\`${probe.replace("@G", `\${${groupVar}}`).replace("@M", `\${${moneyExpr}}`).replace("@C", `\${${countVar}}`)}\``;
}

function unknownExpression(spec) {
  return `\`${spec.unknown("@I").replace("@I", "${id}")}\``;
}

function detailExpression(spec) {
  const probe = spec.detail1(
    { id: "@I", [spec.group]: "@G", [spec.note]: "@N" },
    spec.group,
    spec.note,
  );
  return `\`${probe
    .replace("@I", "${r.id}")
    .replace("@G", `\${r.${spec.group}}`)
    .replace("@N", `\${r.${spec.note}}`)}\``;
}

// ---------------------------------------------------------------------------
// Template p2: commands. Two subcommands share one new flag parser.
// ---------------------------------------------------------------------------

const COMMANDS = {
  x: {
    noun: "task",
    dataFile: "src/store.mjs",
    helperFile: "src/flags.mjs",
    helperFn: "parseFlags",
    errorClass: "UsageError",
    item1File: "src/cmd-list.mjs",
    item1Fn: "runList",
    item2File: "src/cmd-export.mjs",
    item2Fn: "runExport",
    fields: ["id", "state", "title"],
    filterFlag: "state",
    limitFlag: "limit",
    formatFlag: "format",
    listVerb: "list",
    exportVerb: "export",
    records: [
      ["T-1", "open", "write docs"],
      ["T-2", "done", "fix, then ship"],
      ["T-3", "open", 'say "hi"'],
      ["T-4", "blocked", "wait for review"],
    ],
  },
  y: {
    noun: "bookmark",
    dataFile: "src/shelf.mjs",
    helperFile: "src/args.mjs",
    helperFn: "readFlags",
    errorClass: "BadUsage",
    item1File: "src/cmd-find.mjs",
    item1Fn: "runFind",
    item2File: "src/cmd-dump.mjs",
    item2Fn: "runDump",
    fields: ["id", "tag", "url"],
    filterFlag: "tag",
    limitFlag: "max",
    formatFlag: "as",
    listVerb: "find",
    exportVerb: "dump",
    records: [
      ["B-1", "read", "https://example.test/a"],
      ["B-2", "later", "https://example.test/q?a=1,2"],
      ["B-3", "read", 'https://example.test/"b"'],
      ["B-4", "watch", "https://example.test/c"],
    ],
  },
};

function csvField(value) {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function commandsRecords(spec) {
  return spec.records.map((r) =>
    Object.fromEntries(spec.fields.map((f, i) => [f, r[i]])),
  );
}

function parseModel(spec, argv, allowed, amended) {
  const flags = {};
  const rest = [];
  for (const token of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(token);
    if (!m) {
      rest.push(token);
      continue;
    }
    if (!allowed.includes(m[1])) {
      if (amended) {
        return {
          throws: { name: spec.errorClass, message: `unknown flag: --${m[1]}` },
        };
      }
      continue;
    }
    flags[m[1]] = m[2] === undefined ? true : m[2];
  }
  return { equals: { flags, rest } };
}

/** Model of a command run: returns { code, out, err } under D0 or D1. */
function commandModel(spec, verb, argv, amended) {
  const records = commandsRecords(spec);
  const allowed =
    verb === "list"
      ? [spec.filterFlag, spec.limitFlag]
      : [spec.formatFlag, spec.filterFlag];
  const parsed = parseModel(spec, argv, allowed, amended);
  if (parsed.throws) return { code: 64, out: [], err: [parsed.throws.message] };
  const { flags } = parsed.equals;
  let selected = records;
  if (typeof flags[spec.filterFlag] === "string") {
    selected = selected.filter(
      (r) => r[spec.fields[1]] === flags[spec.filterFlag],
    );
  }
  if (verb === "list") {
    if (flags[spec.limitFlag] !== undefined) {
      const n = flags[spec.limitFlag];
      if (!/^[1-9]\d*$/.test(String(n))) {
        return { code: 64, out: [], err: [`invalid ${spec.limitFlag}: ${n}`] };
      }
      selected = selected.slice(0, Number(n));
    }
    return {
      code: 0,
      out: selected.map((r) => spec.fields.map((f) => r[f]).join("\t")),
      err: [],
    };
  }
  const format = flags[spec.formatFlag];
  if (format === undefined || format === true) {
    return { code: 64, out: [], err: [`missing --${spec.formatFlag}`] };
  }
  if (format === "csv") {
    return {
      code: 0,
      out: [
        spec.fields.join(","),
        ...selected.map((r) =>
          spec.fields.map((f) => csvField(r[f])).join(","),
        ),
      ],
      err: [],
    };
  }
  if (format === "json") {
    return { code: 0, out: [JSON.stringify(selected)], err: [] };
  }
  return { code: 64, out: [], err: [`unsupported format: ${format}`] };
}

function commandCases(spec, amended) {
  const records = commandsRecords(spec);
  const f = spec;
  const cases = [];
  const addCall = (name, tags, file, fn, args, expectFor) => {
    const e0 = expectFor(false);
    const e1 = expectFor(true);
    const differs = JSON.stringify(e0) !== JSON.stringify(e1);
    cases.push({
      name,
      tags: differs ? [...tags, DECISION_ID] : tags,
      kind: "call",
      file,
      fn,
      args,
      expect: amended ? e1 : e0,
    });
  };
  const addCmd = (name, tags, file, fn, verb, argv) => {
    const e0 = commandModel(spec, verb, argv, false);
    const e1 = commandModel(spec, verb, argv, true);
    const differs = JSON.stringify(e0) !== JSON.stringify(e1);
    cases.push({
      name,
      tags: differs ? [...tags, DECISION_ID] : tags,
      kind: "cmd",
      file,
      fn,
      argv,
      records,
      expect: amended ? e1 : e0,
    });
  };
  const parseCase = (name, argv, allowed) =>
    addCall(name, ["x"], f.helperFile, f.helperFn, [argv, allowed], (a) =>
      parseModel(spec, argv, allowed, a),
    );
  parseCase(
    "flags with values and positionals",
    [`--${f.filterFlag}=open`, `--${f.limitFlag}=3`, "extra"],
    [f.filterFlag, f.limitFlag],
  );
  parseCase("bare flag", ["--verbose"], ["verbose"]);
  parseCase("unknown flag", ["--colour=red"], [f.filterFlag]);
  const lf = `--${f.filterFlag}=`;
  const lm = `--${f.limitFlag}=`;
  addCmd(
    `${f.listVerb} with no flags`,
    ["item1"],
    f.item1File,
    f.item1Fn,
    "list",
    [],
  );
  addCmd(
    `${f.listVerb} filtered and limited`,
    ["item1"],
    f.item1File,
    f.item1Fn,
    "list",
    [`${lf}${f.records[0][1]}`, `${lm}1`],
  );
  addCmd(
    `${f.listVerb} with an invalid limit`,
    ["item1"],
    f.item1File,
    f.item1Fn,
    "list",
    [`${lm}0`],
  );
  addCmd(
    `${f.listVerb} with an unknown flag`,
    ["item1"],
    f.item1File,
    f.item1Fn,
    "list",
    ["--colour=red"],
  );
  const ff = `--${f.formatFlag}=`;
  addCmd(`${f.exportVerb} csv`, ["item2"], f.item2File, f.item2Fn, "export", [
    `${ff}csv`,
  ]);
  addCmd(
    `${f.exportVerb} json filtered`,
    ["item2"],
    f.item2File,
    f.item2Fn,
    "export",
    [`${ff}json`, `${lf}${f.records[0][1]}`],
  );
  addCmd(
    `${f.exportVerb} without a format`,
    ["item2"],
    f.item2File,
    f.item2Fn,
    "export",
    [],
  );
  addCmd(
    `${f.exportVerb} with an unsupported format`,
    ["item2"],
    f.item2File,
    f.item2Fn,
    "export",
    [`${ff}xml`],
  );
  addCmd(
    `${f.exportVerb} with an unknown flag`,
    ["item2"],
    f.item2File,
    f.item2Fn,
    "export",
    [`${ff}csv`, "--colour=red"],
  );
  return cases;
}

function commandsNotes(spec) {
  return [
    "# Project notes",
    "",
    `Small command-line library over ${spec.noun}s. Run the visible tests with \`node --test test/\`.`,
    "",
    "## Layout",
    "",
    `- \`${spec.dataFile}\`: sample ${spec.noun} records. Do not edit.`,
    `- \`${spec.helperFile}\`: shared helpers. \`${spec.helperFn}(argv, allowed)\` and the \`${spec.errorClass}\` class are missing and must exist exactly once.`,
    `- \`${spec.item1File}\`: \`${spec.item1Fn}(argv, io, records)\` (work item 1).`,
    `- \`${spec.item2File}\`: \`${spec.item2Fn}(argv, io, records)\` (work item 2).`,
    "- `src/index.mjs`: re-exports every module.",
    "",
    "## Conventions",
    "",
    "- `io` is `{ out(line), err(line) }`; a command returns its exit code as a number.",
    `- \`${spec.helperFn}(argv, allowed)\` returns \`{ flags, rest }\`: \`--name=value\` sets \`flags.name\`, bare \`--name\` sets it to \`true\`, other tokens go to \`rest\`.`,
    "",
    "## Decision D0 (original)",
    "",
    "Flags not listed in `allowed` are ignored: they are left out of `flags` and `rest`. Commands carry on as if the flag was not given.",
    "",
    "## Working agreement",
    "",
    "- One branch per worker, named after its role. Commit your own work; never rewrite another branch.",
    "- Do not edit the data module, this file or existing tests.",
    "",
  ].join("\n");
}

function commandsTree(spec, key) {
  const files = {};
  files["package.json"] = `${JSON.stringify(
    {
      name: `study-fixture-${key}`,
      private: true,
      type: "module",
      scripts: { test: "node --test test/" },
    },
    null,
    2,
  )}\n`;
  files[spec.dataFile] = [
    `// Sample ${spec.noun} records.`,
    `export const records = ${JSON.stringify(commandsRecords(spec), null, 2)};`,
    "",
  ].join("\n");
  files[spec.helperFile] = [
    "// Shared command-line helpers.",
    `// ${spec.helperFn} and ${spec.errorClass} are NOT implemented yet; both work items need them.`,
    "",
    "export function normalizeName(name) {",
    "  return String(name).trim().toLowerCase();",
    "}",
    "",
  ].join("\n");
  files[spec.item1File] = [
    `export function ${spec.item1Fn}(argv, io, records) {`,
    '  throw new Error("not implemented");',
    "}",
    "",
  ].join("\n");
  files[spec.item2File] = [
    `export function ${spec.item2Fn}(argv, io, records) {`,
    '  throw new Error("not implemented");',
    "}",
    "",
  ].join("\n");
  const mods = [spec.dataFile, spec.helperFile, spec.item1File, spec.item2File];
  files["src/index.mjs"] = `${mods
    .map((m) => `export * from "./${m.slice("src/".length)}";`)
    .join("\n")}\n`;
  files["test/smoke.test.mjs"] = [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'import * as api from "../src/index.mjs";',
    "",
    'test("public surface is exported", () => {',
    `  assert.equal(typeof api.${spec.item1Fn}, "function");`,
    `  assert.equal(typeof api.${spec.item2Fn}, "function");`,
    '  assert.equal(typeof api.normalizeName, "function");',
    "});",
    "",
  ].join("\n");
  files["NOTES.md"] = commandsNotes(spec);
  return files;
}

function commandsReference(spec, amended) {
  const unknownBranch = amended
    ? [
        "    if (!allowed.includes(name)) {",
        `      throw new ${spec.errorClass}(\`unknown flag: --\${name}\`);`,
        "    }",
      ]
    : ["    if (!allowed.includes(name)) continue;"];
  const helper = [
    "export function normalizeName(name) {",
    "  return String(name).trim().toLowerCase();",
    "}",
    "",
    `export class ${spec.errorClass} extends Error {`,
    "  constructor(message) {",
    "    super(message);",
    `    this.name = "${spec.errorClass}";`,
    "  }",
    "}",
    "",
    `export function ${spec.helperFn}(argv, allowed) {`,
    "  const flags = {};",
    "  const rest = [];",
    "  for (const token of argv) {",
    "    const m = /^--([^=]+)(?:=(.*))?$/.exec(token);",
    "    if (!m) {",
    "      rest.push(token);",
    "      continue;",
    "    }",
    "    const name = m[1];",
    ...unknownBranch,
    "    flags[name] = m[2] === undefined ? true : m[2];",
    "  }",
    "  return { flags, rest };",
    "}",
    "",
  ].join("\n");
  const [, stateField] = spec.fields;
  const importLine = `import { ${spec.helperFn}, ${spec.errorClass} } from "./${spec.helperFile.slice(4)}";`;
  const item1 = [
    importLine,
    "",
    `export function ${spec.item1Fn}(argv, io, records) {`,
    "  try {",
    `    const { flags } = ${spec.helperFn}(argv, ["${spec.filterFlag}", "${spec.limitFlag}"]);`,
    "    let rows = records;",
    `    if (typeof flags.${spec.filterFlag} === "string") {`,
    `      rows = rows.filter((r) => r.${stateField} === flags.${spec.filterFlag});`,
    "    }",
    `    if (flags.${spec.limitFlag} !== undefined) {`,
    `      const n = flags.${spec.limitFlag};`,
    "      if (!/^[1-9]\\d*$/.test(String(n))) {",
    `        throw new ${spec.errorClass}(\`invalid ${spec.limitFlag}: \${n}\`);`,
    "      }",
    "      rows = rows.slice(0, Number(n));",
    "    }",
    "    for (const r of rows) {",
    `      io.out([${spec.fields.map((f) => `r.${f}`).join(", ")}].join("\\t"));`,
    "    }",
    "    return 0;",
    "  } catch (error) {",
    `    if (!(error instanceof ${spec.errorClass})) throw error;`,
    "    io.err(error.message);",
    "    return 64;",
    "  }",
    "}",
    "",
  ].join("\n");
  const item2 = [
    importLine,
    "",
    "function csvField(value) {",
    '  return /[",\\n]/.test(value) ? `"${value.replace(/"/g, \'""\')}"` : value;',
    "}",
    "",
    `export function ${spec.item2Fn}(argv, io, records) {`,
    "  try {",
    `    const { flags } = ${spec.helperFn}(argv, ["${spec.formatFlag}", "${spec.filterFlag}"]);`,
    "    let rows = records;",
    `    if (typeof flags.${spec.filterFlag} === "string") {`,
    `      rows = rows.filter((r) => r.${stateField} === flags.${spec.filterFlag});`,
    "    }",
    `    const format = flags.${spec.formatFlag};`,
    `    if (format === undefined || format === true) throw new ${spec.errorClass}("missing --${spec.formatFlag}");`,
    '    if (format === "csv") {',
    `      io.out(${JSON.stringify(spec.fields.join(","))});`,
    `      for (const r of rows) io.out([${spec.fields.map((f) => `r.${f}`).join(", ")}].map(csvField).join(","));`,
    '    } else if (format === "json") {',
    "      io.out(JSON.stringify(rows));",
    "    } else {",
    `      throw new ${spec.errorClass}(\`unsupported format: \${format}\`);`,
    "    }",
    "    return 0;",
    "  } catch (error) {",
    `    if (!(error instanceof ${spec.errorClass})) throw error;`,
    "    io.err(error.message);",
    "    return 64;",
    "  }",
    "}",
    "",
  ].join("\n");
  return {
    helper: { [spec.helperFile]: helper },
    item1: { [spec.item1File]: item1 },
    item2: { [spec.item2File]: item2 },
  };
}

// ---------------------------------------------------------------------------
// Scenario assembly
// ---------------------------------------------------------------------------

function itemText(spec, template, which) {
  if (template === "report") {
    const sample = reportSummary(
      spec,
      toRecords(spec).slice(0, 2),
      false,
    ).split("\n");
    if (which === "item1") {
      return [
        `Implement \`${spec.item1Fn}(rows)\` in \`${spec.item1File}\` and return a string (lines joined with "\\n", no trailing newline):`,
        "",
        `1. \`${spec.header("<n>", spec.plural)}\``,
        `2. one line per ${spec.group}, ${spec.group} names sorted ascending: \`${spec.line(`<${spec.group}>`, "<total>", "<count>")}\``,
        `3. \`${spec.totalLabel}: <total>\``,
        "",
        `Totals are sums of \`cents\`; render every amount with \`${spec.helperFn}(cents)\` from \`${spec.helperFile}\`. Example first line for two rows: \`${sample[0]}\`.`,
      ].join("\n");
    }
    return [
      `Implement \`${spec.item2Fn}(rows, id)\` in \`${spec.item2File}\` and return two lines joined with "\\n":`,
      "",
      `1. \`${spec.detail1({ id: "<id>", [spec.group]: `<${spec.group}>`, [spec.note]: `<${spec.note}>` }, spec.group, spec.note)}\``,
      `2. \`${spec.amountLabel}: <amount>\``,
      "",
      `Render the amount with \`${spec.helperFn}(cents)\` from \`${spec.helperFile}\`. An id that is not in \`rows\` throws \`RangeError("${spec.unknown("<id>")}")\`.`,
    ].join("\n");
  }
  if (which === "item1") {
    return [
      `Implement \`${spec.item1Fn}(argv, io, records)\` in \`${spec.item1File}\` for the \`${spec.listVerb}\` command:`,
      "",
      `- \`--${spec.filterFlag}=<value>\` keeps records whose \`${spec.fields[1]}\` equals the value.`,
      `- \`--${spec.limitFlag}=<n>\` keeps the first n records after filtering; n must be a positive integer, otherwise the command fails with \`invalid ${spec.limitFlag}: <n>\`.`,
      `- Print one line per record to \`io.out\`: \`${spec.fields.map((f) => `<${f}>`).join("<TAB>")}\`. Return 0.`,
      `- A \`${spec.errorClass}\` from the shared parser is written to \`io.err\` and the command returns 64.`,
      "",
      `Parse flags with the shared \`${spec.helperFn}(argv, allowed)\` from \`${spec.helperFile}\`.`,
    ].join("\n");
  }
  return [
    `Implement \`${spec.item2Fn}(argv, io, records)\` in \`${spec.item2File}\` for the \`${spec.exportVerb}\` command:`,
    "",
    `- \`--${spec.formatFlag}=csv\`: header \`${spec.fields.join(",")}\` then one row per record. A field containing a comma, a double quote or a newline is wrapped in double quotes with embedded quotes doubled.`,
    `- \`--${spec.formatFlag}=json\`: one line, \`JSON.stringify\` of the selected records.`,
    `- \`--${spec.filterFlag}=<value>\` keeps records whose \`${spec.fields[1]}\` equals the value.`,
    `- A missing format fails with \`missing --${spec.formatFlag}\`; any other format fails with \`unsupported format: <value>\`. Failures are written to \`io.err\` and the command returns 64.`,
    "",
    `Parse flags with the shared \`${spec.helperFn}(argv, allowed)\` from \`${spec.helperFile}\`.`,
  ].join("\n");
}

const DECISION_TEXT = {
  report: (spec) =>
    `Decision D1 supersedes D0 for \`${spec.helperFn}\`: a negative amount renders in parentheses with the symbol inside, for example \`${money(spec, -1250, true)}\`, and a major part of 1000 or more uses "," as the thousands separator, for example \`${money(spec, 123456, true)}\`. Both work items must follow D1.`,
  commands: (spec) =>
    `Decision D1 supersedes D0 for \`${spec.helperFn}\`: a flag that is not in \`allowed\` is an error. \`${spec.helperFn}\` throws \`${spec.errorClass}\` (exported from \`${spec.helperFile}\`) with the message \`unknown flag: --<name>\`, and both commands report it on \`io.err\` and return 64. Both work items must follow D1.`,
};

const DECISION_KEYS = {
  report: ["parenthes", "1,234", "thousand"],
  commands: ["unknown flag", "64"],
};

/** Build one scenario (pair, variant): repository, frozen cases, references, fact sheet. */
export function buildScenario(pair, variant) {
  const template = pair === "p1" ? "report" : "commands";
  const spec = (template === "report" ? REPORT : COMMANDS)[variant];
  if (!spec) throw new Error(`unknown variant ${variant}`);
  const key = `${pair}-${variant}`;
  const repoFiles =
    template === "report" ? reportTree(spec, key) : commandsTree(spec, key);
  const cases =
    template === "report" ? reportCases(spec, true) : commandCases(spec, true);
  const ref = (amended) =>
    template === "report"
      ? reportReference(spec, amended)
      : commandsReference(spec, amended);
  const helperName = spec.helperFn;
  const scenario = {
    id: key,
    pair,
    variant,
    template,
    helper: {
      file: spec.helperFile,
      name: helperName,
      errorClass: spec.errorClass ?? null,
    },
    items: {
      item1: {
        file: spec.item1File,
        fn: spec.item1Fn,
        text: itemText(spec, template, "item1"),
      },
      item2: {
        file: spec.item2File,
        fn: spec.item2Fn,
        text: itemText(spec, template, "item2"),
      },
    },
    repoFiles,
    cases,
    reference: { amended: ref(true), original: ref(false) },
    decision: {
      id: DECISION_ID,
      text: DECISION_TEXT[template](spec),
      keyPhrases: DECISION_KEYS[template],
    },
    frozenPaths: [
      spec.dataFile,
      "NOTES.md",
      "package.json",
      "test/smoke.test.mjs",
    ],
    sharedPaths: [spec.helperFile, "src/index.mjs"],
  };
  scenario.sha256 = sha256(
    canonicalJson({
      id: scenario.id,
      helper: scenario.helper,
      items: scenario.items,
      repoFiles: scenario.repoFiles,
      cases: scenario.cases,
      reference: scenario.reference,
      decision: scenario.decision,
      frozenPaths: scenario.frozenPaths,
      sharedPaths: scenario.sharedPaths,
    }),
  );
  return scenario;
}

export function allScenarios() {
  return PAIRS.flatMap((pair) =>
    VARIANTS.map((variant) => buildScenario(pair, variant)),
  );
}

/** Files a role may legitimately touch. Anything else is a forbidden path. */
export function allowedPaths(scenario, role, itemKey) {
  const own = scenario.items[itemKey].file;
  return {
    exact: [own, ...scenario.sharedPaths],
    prefixNewOnly: ["test/"],
    role,
  };
}

export function materializeFiles(files, dir) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

// ---------------------------------------------------------------------------
// Frozen acceptance runner (written outside every worktree) and fact sheet
// ---------------------------------------------------------------------------

/**
 * Standalone runner source. Usage: node accept.mjs <tree> <cases.json>.
 * Prints one JSON object { results: [{name, tags, pass, error}] } and exits 0.
 */
export const ACCEPT_RUNNER_SOURCE = `import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [tree, casesFile] = process.argv.slice(2);
const cases = JSON.parse(readFileSync(casesFile, "utf8"));
const results = [];
for (const c of cases) {
  const record = { name: c.name, tags: c.tags, pass: false, error: null };
  try {
    const mod = await import(pathToFileURL(join(tree, c.file)).href);
    const fn = mod[c.fn];
    if (typeof fn !== "function") throw new Error("missing export " + c.fn);
    if (c.kind === "cmd") {
      const out = [];
      const err = [];
      const code = await fn(c.argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, c.records);
      record.pass = isDeepStrictEqual({ code, out, err }, c.expect);
      if (!record.pass) record.error = "expected " + JSON.stringify(c.expect) + " got " + JSON.stringify({ code, out, err });
    } else if (c.expect.throws) {
      try {
        await fn(...c.args);
        record.error = "did not throw";
      } catch (e) {
        record.pass = e?.name === c.expect.throws.name && e?.message === c.expect.throws.message;
        if (!record.pass) record.error = "threw " + e?.name + ": " + e?.message;
      }
    } else {
      const got = await fn(...c.args);
      record.pass = isDeepStrictEqual(JSON.parse(JSON.stringify(got)), c.expect.equals);
      if (!record.pass) record.error = "expected " + JSON.stringify(c.expect.equals) + " got " + JSON.stringify(got);
    }
  } catch (e) {
    record.error = String(e?.message ?? e);
  }
  results.push(record);
}
console.log(JSON.stringify({ results }));
`;

/** Six-fact handoff fact sheet; each fact passes when any alternative's regexes all match. */
export function factSheet(scenario, role, itemKey) {
  const item = scenario.items[itemKey];
  const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const decisionKey = scenario.decision.keyPhrases.map(reEscape).join("|");
  return {
    role,
    facts: [
      {
        id: "goal_acceptance",
        label: "goal and acceptance",
        alternatives: [
          [reEscape(item.fn), `${reEscape(item.file)}|accept|spec`],
        ],
      },
      {
        id: "current_status",
        label: "current status",
        alternatives: [
          [
            "\\b(done|complete|completed|in[ -]progress|blocked|not started)\\b",
          ],
        ],
      },
      {
        id: "artifact_refs",
        label: "artifact or commit references",
        alternatives: [
          ["\\b[0-9a-f]{7,40}\\b"],
          [`branch ${reEscape(role)}|\\b${reEscape(role)}\\b.*branch`],
        ],
      },
      {
        id: "verification",
        label: "verification results",
        alternatives: [["\\b(pass(ed|es)?|fail(ed|s|ing)?)\\b", "test"]],
      },
      {
        id: "decision_or_blocker",
        label: "active decision or blocker",
        alternatives: [[reEscape(scenario.decision.id), decisionKey]],
      },
      {
        id: "next_owner_action",
        label: "next owner and action",
        alternatives: [
          ["\\bnext\\b", `${reEscape(role)}|replacement|orchestrator|w[12]r?`],
        ],
      },
    ],
  };
}

/** Score handoff text against a fact sheet. Mechanical: a lower bound, not a judgement. */
export function scoreHandoff(text, sheet) {
  const results = sheet.facts.map((fact) => {
    const ok = fact.alternatives.some((group) =>
      group.every((pattern) => new RegExp(pattern, "i").test(text)),
    );
    return { id: fact.id, label: fact.label, present: ok };
  });
  return {
    score: results.filter((r) => r.present).length,
    max: results.length,
    facts: results,
  };
}

/** Does a RESUME note state the active decision? */
export function resumeStatesDecision(text, scenario) {
  const line = text.split("\n").find((l) => /^DECISION:/i.test(l.trim()));
  if (!line) return false;
  if (!new RegExp(scenario.decision.id, "i").test(line)) return false;
  return scenario.decision.keyPhrases.some((k) =>
    line.toLowerCase().includes(k.toLowerCase()),
  );
}

// ---------------------------------------------------------------------------
// Worker packets
// ---------------------------------------------------------------------------

const TRAINING = [
  "## How coordination works in this study",
  "",
  "Two coding workers (w1, w2) share this repository through separate git worktrees. Follow the working agreement in NOTES.md.",
  "Your duties are the same whatever tools you have: claim the shared helper before you edit it, acknowledge decision changes, save a handoff when asked, resume from durable resources if you are a replacement, and declare your result explicitly.",
  "You have 40 tool calls and 12 minutes of wall time. Spend them on the task; there is no credit for coordination for its own sake.",
].join("\n");

function conditionAppendix(ctx) {
  const { condition, role, scenario, itemKey, shared } = ctx;
  const helper = scenario.helper.name;
  const itemFile = scenario.items[itemKey].file;
  if (condition === "A") {
    return [
      "## Coordination tools (condition A)",
      "",
      `Shared directory (outside your worktree): \`${shared}\`. It holds BOARD.md, DECISIONS.md and HANDOFFS/.`,
      "",
      `1. Claim: before editing \`${scenario.helper.file}\`, look at BOARD.md. If a line starting \`shared-helper:\` exists, you do not own \`${helper}\`: do not implement it. Otherwise add \`shared-helper: owner=${role} since=<HH:MM:SS>\` and then implement it.`,
      `2. Acknowledge: when the orchestrator posts a decision change, append \`ACK <decision id> ${role}\` to DECISIONS.md.`,
      `3. Handoff: when asked, write HANDOFFS/${role}.md with these headings: Goal and acceptance, Current status, Artifacts and commits, Verification, Active decision or blocker, Next owner and action.`,
      "4. Resume: a replacement reads BOARD.md, DECISIONS.md and HANDOFFS/, then writes RESUME.txt in its worktree root. Line 1: `DECISION: <active decision id and its rule>`. Line 2: `NEXT: <your next action>`.",
      `5. Result: after committing \`${itemFile}\` on your branch, append \`RESULT ${role} <commit sha>\` to BOARD.md. Nothing counts as done until you do.`,
    ].join("\n");
  }
  const { run, trial, participant, runner, taskIds } = ctx;
  const base = `node ${runner} {verb} --run-dir ${run} --trial ${trial} --participant ${participant}`;
  const sdk = (rest) => `${base.replace("{verb}", "sdk")} ${rest}`;
  const cli = (rest) => `${base.replace("{verb}", "tila")} -- ${rest}`;
  return [
    "## Coordination tools (condition B)",
    "",
    `Your participant id is \`${participant}\`. Shared directory (outside your worktree): \`${shared}\`; the tila store is run-owned and outside every worktree. Tasks: helper \`${taskIds.helper}\`, your item \`${taskIds.item}\`.`,
    "",
    `- Claim:   \`${sdk("claim task:<id> --ttl-ms 120000")}\` prints the fence on success and exits non-zero with \`already-held\` when someone else holds it. Never use \`tila task claim\`; its report is not reliable for a lost claim.`,
    `- Renew:   \`${sdk("renew task:<id> --fence <n> --ttl-ms 120000")}\``,
    `- Update:  \`${cli("task update <id> --field <name>=<value> --fence <n> --json")}\``,
    `- Show:    \`${cli("task show <id> --json")}\``,
    `- Handoff: \`${sdk("handoff-create --summary <text> --ref task:<id>")}\`; resume: \`${sdk("reentry")}\``,
    "",
    `1. Claim: claim \`task:${taskIds.helper}\` before editing \`${scenario.helper.file}\`. If you lose it you do not own \`${helper}\`: do not implement it.`,
    `2. Claim your item \`task:${taskIds.item}\` once to get a fence for your updates; if an update is rejected as a stale fence, claim again and retry once.`,
    `3. Acknowledge: when the orchestrator posts a decision change, run \`task update ${taskIds.item} --field decision_ack=<decision id> --fence <n>\`.`,
    "4. Handoff: when asked, create a handoff whose summary covers: goal and acceptance, current status, artifacts and commits, verification, active decision or blocker, next owner and action.",
    "5. Resume: a replacement runs `reentry`, reads the task state, then writes RESUME.txt in its worktree root. Line 1: `DECISION: <active decision id and its rule>`. Line 2: `NEXT: <your next action>`.",
    `6. Result: after committing \`${itemFile}\` on your branch, run \`task update ${taskIds.item} --field status=done --fence <n>\` with the commit sha in \`--field result_commit=<sha>\`. Nothing counts as done until you do.`,
  ].join("\n");
}

/** Render the packet a worker receives at T0. */
export function renderWorkerPacket(ctx) {
  const { scenario, itemKey, role, worktree, branch } = ctx;
  const item = scenario.items[itemKey];
  const other = role === "w1" ? "w2" : "w1";
  return [
    `# Work item for ${role}`,
    "",
    `Repository: \`${worktree}\` (branch \`${branch}\`). Worker ${other} works in the same repository in parallel on the other item.`,
    "Read NOTES.md first.",
    "",
    "## Your item",
    "",
    item.text,
    "",
    "## Shared helper",
    "",
    `Both work items need \`${scenario.helper.name}\` in \`${scenario.helper.file}\`. It must be implemented exactly once. Whoever claims it implements it; the other worker codes against the signature in NOTES.md and obtains the implementation from the owner's branch (for example \`git merge <branch>\`) rather than writing a second one.`,
    "",
    "## Constraints",
    "",
    `- Edit only \`${item.file}\`, \`${scenario.helper.file}\` (if you own the helper) and \`src/index.mjs\`. Add tests only as new files under \`test/\`.`,
    "- Do not edit the data module, NOTES.md or existing tests.",
    "- Do not look for acceptance tests; they are not available to you.",
    "",
    TRAINING,
    "",
    conditionAppendix(ctx),
    "",
  ].join("\n");
}

export function renderEntryPacket(ctx) {
  const { scenario, itemKey, role, worktree, branch } = ctx;
  const item = scenario.items[itemKey];
  return [
    `# Replacement entry packet (${role})`,
    "",
    `You continue the work of an earlier worker whose context ended. Repository: \`${worktree}\` (branch \`${branch}\`). You have only this packet and the durable resources below; you do not have the previous conversation.`,
    "",
    `The item is \`${item.fn}\` in \`${item.file}\`; the shared helper is \`${scenario.helper.name}\` in \`${scenario.helper.file}\`. Read NOTES.md and the existing diff (\`git status\`, \`git log\`, \`git diff\`) before editing.`,
    "",
    "Your first action must be to write RESUME.txt as described below, before any edit.",
    "",
    TRAINING,
    "",
    conditionAppendix(ctx),
    "",
  ].join("\n");
}

export function renderDecisionMessage(scenario) {
  return `Decision change ${scenario.decision.id}: ${scenario.decision.text}\nAcknowledge it in your system of record as described in your packet.`;
}

/** Length of the condition-specific appendix, for the equal-training check. */
export function appendixLength(ctx) {
  return conditionAppendix(ctx).length;
}
