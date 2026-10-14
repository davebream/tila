import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, expect, it } from "vitest";

const workerRoot = resolve(import.meta.dirname, "..");
let consumer: string;

beforeAll(() => {
  consumer = mkdtempSync(join(tmpdir(), "tila-human-auth-declarations-"));
  // Emit the actual exported declarations, then compile a consumer with no
  // workspace source aliases. Dependencies retain the divergent better-calls.
  execFileSync(
    "pnpm",
    [
      "exec",
      "tsc",
      "--emitDeclarationOnly",
      "--declarationMap",
      "false",
      "--outDir",
      join(consumer, "declarations"),
    ],
    { cwd: workerRoot, stdio: "pipe" },
  );
  symlinkSync(join(workerRoot, "node_modules"), join(consumer, "node_modules"));
}, 120_000);

afterAll(() => {
  if (consumer) rmSync(consumer, { recursive: true, force: true });
});

const imports = `import {
  createHumanAuth, type HumanAuth, type HumanSession,
} from "./declarations/d1/human-auth";
import { accountAuth } from "./declarations/lib/human-auth";
`;

const valid = `${imports}
type Assert<T extends true> = T;
type Same<X, Y> = (<T>() => T extends X ? 1 : 2) extends
  (<T>() => T extends Y ? 1 : 2) ? true : false;
type FactoryReturn = Assert<Same<ReturnType<typeof createHumanAuth>, HumanAuth>>;
type AccountReturn = Assert<Same<ReturnType<typeof accountAuth>, Promise<HumanAuth>>>;
type Role = Assert<Same<HumanSession["user"]["role"], string>>;
type Disabled = Assert<Same<HumanSession["user"]["disabled"], boolean>>;
type Device = Assert<Same<HumanSession["session"]["device"], boolean>>;
type Project = Assert<Same<HumanSession["session"]["projectId"], string>>;
type AuthenticatedAt = Assert<Same<HumanSession["session"]["authenticatedAt"], number | undefined | null>>;
type DeviceName = Assert<Same<HumanSession["session"]["deviceName"], string | undefined | null>>;
type ParentSession = Assert<Same<HumanSession["session"]["parentSessionId"], string | undefined | null>>;
type SharedSession = Assert<HumanAuth["$Infer"]["Session"] extends HumanSession ? true : false>;
type SessionShared = Assert<HumanSession extends HumanAuth["$Infer"]["Session"] ? true : false>;
type PluginIDs = Assert<Same<HumanAuth["options"]["plugins"][number]["id"],
  "bearer" | "tila-handoff" | "device-authorization">>;

async function consume(auth: HumanAuth, headers: Headers) {
  const current = await auth.api.getSession({ headers });
  type Inferred = Assert<Same<typeof current, HumanSession | null>>;
  const response = await auth.api.getSession({ headers, asResponse: true });
  type ResponseMode = Assert<Same<typeof response, Response>>;
  const withHeaders = await auth.api.getSession({ headers, returnHeaders: true });
  type HeadersMode = Assert<Same<typeof withHeaders.response, HumanSession | null>>;
  const handoff = await auth.api.consumeHandoff({ body: { token: "a".repeat(64) } });
  type Handoff = Assert<Same<typeof handoff, Response | { ok: boolean }>>;
  const handoffResponse = await auth.api.consumeHandoff({ body: { token: "a".repeat(64) }, asResponse: true });
  type HandoffResponse = Assert<Same<typeof handoffResponse, Response>>;
  await auth.api.deviceCode({ body: { client_id: "tila-cli:fixture" } });
  await auth.api.deviceToken({ body: { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "code", client_id: "tila-cli:fixture" } });
  await auth.api.deviceVerify({ query: { user_code: "code" } });
  await auth.api.deviceApprove({ headers, body: { userCode: "code" } });
  await auth.api.deviceDeny({ headers, body: { userCode: "code" } });
  await auth.api.signOut({ headers, asResponse: true });
}
`;

const invalid = `${imports}
declare const auth: HumanAuth;
declare const session: HumanSession;
const wrongRole: number = session.user.role;
const wrongDevice: string = session.session.device;
const wrongTime: string = session.session.authenticatedAt;
auth.api.consumeHandoff({ body: { token: 42 } });
auth.api.deviceApprove({ headers: new Headers(), body: { userCode: 42 } });
auth.api.missingEndpoint({});
`;

function compile(name: string, source: string) {
  const file = join(consumer, name);
  writeFileSync(file, source);
  const program = ts.createProgram([file], {
    strict: true,
    noEmit: true,
    // Match the Worker's upstream library policy; the consumer itself is strict.
    skipLibCheck: true,
    types: ["@cloudflare/workers-types", "node"],
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  });
  return ts.getPreEmitDiagnostics(program);
}

it("emits portable auth declarations with inferred fields and every plugin endpoint", () => {
  for (const file of ["d1/human-auth.d.ts", "lib/human-auth.d.ts"]) {
    const declaration = readFileSync(
      join(consumer, "declarations", file),
      "utf8",
    );
    expect(declaration).not.toMatch(
      /\.pnpm|node_modules|better-auth\/dist|better-call\//,
    );
  }
  const diagnostics = compile("valid.ts", valid);
  expect(
    diagnostics.map(
      (entry) =>
        `${entry.file?.getLineAndCharacterOfPosition(entry.start ?? 0).line}: ${ts.flattenDiagnosticMessageText(entry.messageText, "\n")}`,
    ),
  ).toEqual([]);
}, 120_000);

it("rejects invalid auth fields and endpoint calls through emitted declarations", () => {
  const diagnostics = compile("invalid.ts", invalid);
  expect(diagnostics.map((entry) => entry.code).sort()).toEqual([
    2322, 2322, 2322, 2339, 2769, 2769,
  ]);
  expect(
    diagnostics.every(
      (entry) => entry.file?.fileName === join(consumer, "invalid.ts"),
    ),
  ).toBe(true);
}, 120_000);
