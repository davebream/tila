import { execFileSync, execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, expect, it } from "vitest";

const sdkRoot = resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
let consumer: string;

// This consumer has no workspace paths, private packages or ambient @types.
// Only the actual packed SDK and its public zod dependency are made available.
beforeAll(() => {
  if (!existsSync(join(sdkRoot, "dist/index.d.ts")))
    execSync("pnpm --filter tila-sdk build", {
      cwd: resolve(sdkRoot, "../.."),
      stdio: "pipe",
    });
  consumer = mkdtempSync(join(tmpdir(), "tila-packed-warning-types-"));
  execFileSync("pnpm", ["pack", "--pack-destination", consumer], {
    cwd: sdkRoot,
    stdio: "pipe",
  });
  const tarball = readdirSync(consumer).find((name) => name.endsWith(".tgz"));
  if (!tarball) throw new Error("SDK pack did not produce a tarball");
  const installed = join(consumer, "node_modules/tila-sdk");
  mkdirSync(installed, { recursive: true });
  execFileSync("tar", [
    "-xzf",
    join(consumer, tarball),
    "--strip-components=1",
    "-C",
    installed,
  ]);
  cpSync(
    dirname(require.resolve("zod/package.json")),
    join(consumer, "node_modules/zod"),
    {
      recursive: true,
    },
  );
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
}, 120_000);

afterAll(() => {
  if (consumer) rmSync(consumer, { recursive: true, force: true });
});

const imports = `import {
  TilaClient, createTila,
  type ClientOptions, type SchemaApplyResponse, type SchemaApplyWarning,
  type SchemaWarningSink, type TilaFacade,
} from "tila-sdk";
`;
const valid = `${imports}
type Assert<T extends true> = T;
type IsAny<T> = 0 extends (1 & T) ? true : false;
type NotAny<T> = IsAny<T> extends false ? true : false;
type WarningIsTyped = Assert<NotAny<SchemaApplyWarning>>;
type CodeIsTyped = Assert<NotAny<SchemaApplyWarning["code"]>>;
type RevisionIsTyped = Assert<NotAny<SchemaApplyWarning["result_revision"]>>;
type SinkWarningIsTyped = Assert<NotAny<Parameters<SchemaWarningSink>[0]>>;
type OptionWarningIsTyped = Assert<NotAny<Parameters<NonNullable<ClientOptions["warningSink"]>>[0]>>;
type ResponseWarning = NonNullable<SchemaApplyResponse["warnings"]>[number];
type ResponseWarningIsTyped = Assert<NotAny<ResponseWarning>>;
type ApplyResult = Awaited<ReturnType<TilaFacade["schema"]["apply"]>>;
type AppliedWarningIsTyped = Assert<NotAny<NonNullable<ApplyResult["warnings"]>[number]>>;

const warning: SchemaApplyWarning = {
  code: "schema-revision-deprecated", message: "Preview and send expected_revision",
  observed_revision: 0, result_revision: 1,
};
const warningSink: SchemaWarningSink = (note) => {
  type CallbackIsTyped = Assert<NotAny<typeof note>>;
  const code: "schema-revision-deprecated" = note.code;
  const revision: number = note.result_revision;
  const observation: number | undefined = note.observed_revision;
};
warningSink(warning);
new TilaClient({ baseUrl: "https://example.test", token: "test", warningSink });
void createTila({ project_id: "p", backend: "cloudflare", worker_url: "https://example.test",
  schema_version: 1, tila_version: "0", created_at: "" }, "test", {
  warningSink(note) {
    type InferredWarningIsTyped = Assert<NotAny<typeof note>>;
    const code: "schema-revision-deprecated" = note.code;
  },
});
`;

const invalid = `${imports}
const warning: SchemaApplyWarning = {
  code: "schema-revision-deprecated", message: "Preview", result_revision: 1,
};
const wrongCode: SchemaApplyWarning = { ...warning, code: "invalid-code" };
const wrongRevision: SchemaApplyWarning = { ...warning, result_revision: "one" };
const missingRevision: SchemaApplyWarning = { code: "schema-revision-deprecated", message: "Preview" };
const sink: NonNullable<ClientOptions["warningSink"]> = (note) => { note.unknown_field; };
`;

function compile(name: string, source: string) {
  const file = join(consumer, name);
  writeFileSync(file, source);
  const program = ts.createProgram([file], {
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    types: [],
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  });
  return ts.getPreEmitDiagnostics(program);
}

it.each(["mts", "cts"])(
  "keeps packed %s warning and sink declarations strict in a clean consumer",
  (extension) => {
    const diagnostics = compile(`valid.${extension}`, valid);
    expect(
      diagnostics.map((entry) =>
        ts.flattenDiagnosticMessageText(entry.messageText, "\n"),
      ),
    ).toEqual([]);
    const rejected = compile(`invalid.${extension}`, invalid);
    // Invalid code/revision, missing revision, and an unknown sink field all fail.
    expect(rejected.map((entry) => entry.code).sort()).toEqual([
      2322, 2322, 2339, 2741,
    ]);
    expect(
      rejected.every(
        (entry) =>
          entry.file?.fileName === join(consumer, `invalid.${extension}`),
      ),
    ).toBe(true);
  },
  30_000,
);
