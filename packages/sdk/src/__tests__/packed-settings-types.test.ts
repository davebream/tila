import { execFileSync } from "node:child_process";
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
beforeAll(() => {
  if (!existsSync(join(sdkRoot, "dist/index.d.ts")))
    throw new Error("Build the SDK before packed consumer validation");
  consumer = mkdtempSync(join(tmpdir(), "tila-packed-settings-"));
  execFileSync("pnpm", ["pack", "--pack-destination", consumer], {
    cwd: sdkRoot,
    stdio: "pipe",
  });
  const archive = readdirSync(consumer).find((n) => n.endsWith(".tgz"));
  if (!archive) throw new Error("Missing SDK tarball");
  const installed = join(consumer, "node_modules/tila-sdk");
  mkdirSync(installed, { recursive: true });
  execFileSync("tar", [
    "-xzf",
    join(consumer, archive),
    "--strip-components=1",
    "-C",
    installed,
  ]);
  cpSync(
    dirname(require.resolve("zod/package.json")),
    join(consumer, "node_modules/zod"),
    { recursive: true },
  );
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
}, 120_000);
afterAll(() => {
  if (consumer) rmSync(consumer, { recursive: true, force: true });
});
const imports = `import { TilaClient, createSettingsTransferMethods, SettingsPlanSchema, SettingsReceiptSchema, type SettingsPlan, type SettingsReceipt, type SettingsMappings } from "tila-sdk";`;
const valid = `${imports}
type Assert<T extends true> = T;
type NotAny<T> = 0 extends (1 & T) ? false : true;
type TypedPlan = Assert<NotAny<SettingsPlan>>;
type TypedPayload = Assert<NotAny<SettingsPlan["actions"][number]["payload"]>>;
type TypedReceipt = Assert<NotAny<SettingsReceipt["actions"][number]["status"]>>;
type TypedMappings = Assert<NotAny<SettingsMappings["identities"][string]>>;
const client = new TilaClient({ baseUrl: "https://example.test", token: "fixture" });
const transfer = createSettingsTransferMethods(client, "project");
const receipt: SettingsReceipt = SettingsReceiptSchema.parse({});
const plan: SettingsPlan = SettingsPlanSchema.parse({});
transfer.execute(receipt, async saved => {
  type TypedCallback = Assert<NotAny<typeof saved>>;
  const status: "committed" | "failed" | "uncertain" | "not-attempted" = saved.actions[0].status;
}, { confirmRemovals: true });
`;
const invalid = `${imports}
const bad: SettingsReceipt["actions"][number]["status"] = "done";
const revision: SettingsReceipt["actions"][number]["revision"] = "one";
const mappings: SettingsMappings = { identities: { "principal:source": { target: 2 } }, profiles: {}, resources: { agents: {}, rooms: {}, signal_groups: {} } };
`;
function compile(name: string, text: string) {
  const file = join(consumer, name);
  writeFileSync(file, text);
  return ts.getPreEmitDiagnostics(
    ts.createProgram([file], {
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      types: [],
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    }),
  );
}
it.each(["mts", "cts"])(
  "preserves settings plan/receipt types and runtime exports in the packed %s consumer",
  (extension) => {
    const validErrors = compile(`valid.${extension}`, valid);
    expect(
      validErrors.map((e) =>
        ts.flattenDiagnosticMessageText(e.messageText, "\n"),
      ),
    ).toEqual([]);
    const invalidErrors = compile(`invalid.${extension}`, invalid);
    expect(invalidErrors.map((e) => e.code)).toEqual([2322, 2322, 2322]);
    expect(
      invalidErrors.every(
        (e) => e.file?.fileName === join(consumer, `invalid.${extension}`),
      ),
    ).toBe(true);
    const suffix = extension === "mts" ? "mjs" : "cjs";
    const runtime =
      suffix === "mjs"
        ? 'import { createSettingsTransferMethods, SettingsReceiptSchema } from "tila-sdk"; console.log(typeof createSettingsTransferMethods, typeof SettingsReceiptSchema.parse);'
        : 'const { createSettingsTransferMethods, SettingsReceiptSchema } = require("tila-sdk"); console.log(typeof createSettingsTransferMethods, typeof SettingsReceiptSchema.parse);';
    writeFileSync(join(consumer, `runtime.${suffix}`), runtime);
    expect(
      execFileSync(process.execPath, [`runtime.${suffix}`], {
        cwd: consumer,
        encoding: "utf8",
      }).trim(),
    ).toBe("function function");
  },
  120_000,
);
