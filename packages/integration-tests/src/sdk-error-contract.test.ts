import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { TILA_ERRORS, toTilaErrorCode } from "../../sdk/src/error-codes";

const PACKAGES = join(import.meta.dirname, "../..");

// These modules' `code` fields are not top-level HTTP error codes. Exclude
// occurrences by source, never by value: e.g. schema-corrupt is also emitted
// publicly by error-map.ts, and permission-denied has many public producers.
const INTERNAL_CODE_SOURCES = new Map([
  [
    "worker/src/middleware/dpop.ts",
    "auth.ts wraps rejection details in dpop-invalid",
  ],
  [
    "ops-sqlite/src/ready-ops.ts",
    "successful readiness responses contain reasons",
  ],
  ["core/src/definition-transfer.ts", "nested definition import diagnostics"],
  ["core/src/definition-yaml.ts", "nested YAML import diagnostics"],
  [
    "core/src/settings-transfer.ts",
    "client-side settings validation and planning",
  ],
  ["core/src/settings-execution.ts", "client-side settings execution receipts"],
  [
    "core/src/schema-document.ts",
    "local schema parsing diagnostics; HTTP mapping is in error-map.ts",
  ],
]);

// Constructor code argument positions for families forwarded unchanged by
// mapProjectError or Worker route/auth handlers. Internal errors such as
// OidcDiscoveryError are deliberately absent: they are translated at the edge.
const FORWARDED_ERRORS: Record<string, number | null> = {
  AgentBindingError: 0,
  ArtifactReviewError: 1,
  ArtifactVersionError: 1,
  ContinuityError: 0,
  ConversationError: 0,
  JournalReportError: 0,
  OidcVerificationError: 0,
  QuestionError: 0,
  QueueError: 0,
  RuntimeDenied: 0,
  SchemaPreconditionError: 0,
  TemplateInstantiateError: 0,
  // These two use fixed code properties, not constructor arguments.
  ProjectMaintenanceError: null,
  TransferConflictError: null,
};

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(file);
    return file.endsWith(".ts") && !/\.(test|spec|d)\.ts$/.test(file)
      ? [file]
      : [];
  });
}

/** Bounded syntax inspection, not a general interprocedural data-flow engine. */
function collectEmittedCodes(content: string, file: string): Set<string> {
  if (INTERNAL_CODE_SOURCES.has(file)) return new Set();
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  const codes = new Set<string>();
  const aliases = new Map<string, ts.TypeNode>();
  const constants = new Map<string, ts.Expression>();
  for (const statement of source.statements) {
    if (ts.isTypeAliasDeclaration(statement))
      aliases.set(statement.name.text, statement.type);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer)
          constants.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  function literals(
    node: ts.Node | undefined,
    seen = new Set<ts.Node>(),
  ): void {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (ts.isStringLiteralLike(node)) codes.add(node.text);
    else if (ts.isConditionalExpression(node)) {
      literals(node.whenTrue, seen);
      literals(node.whenFalse, seen);
    } else if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(
        node.operatorToken.kind,
      )
    ) {
      literals(node.left, seen);
      literals(node.right, seen);
    } else if (
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isParenthesizedExpression(node)
    ) {
      literals(node.expression, seen);
    } else if (ts.isLiteralTypeNode(node)) literals(node.literal, seen);
    else if (ts.isUnionTypeNode(node)) {
      for (const type of node.types) literals(type, seen);
    } else if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName))
      literals(aliases.get(node.typeName.text), seen);
    else if (ts.isIdentifier(node)) literals(constants.get(node.text), seen);
  }
  function name(node: ts.Node | undefined): string | undefined {
    return node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node))
      ? node.text
      : undefined;
  }
  function visit(node: ts.Node): void {
    if (ts.isPropertyAssignment(node) && name(node.name) === "code")
      literals(node.initializer);
    if (
      ts.isClassDeclaration(node) &&
      node.name &&
      node.name.text in FORWARDED_ERRORS
    ) {
      for (const member of node.members) {
        if (ts.isPropertyDeclaration(member) && name(member.name) === "code") {
          literals(member.initializer);
          literals(member.type);
        }
        if (ts.isConstructorDeclaration(member)) {
          const index = FORWARDED_ERRORS[node.name.text];
          const parameter =
            index === null ? undefined : member.parameters[index];
          if (parameter) {
            literals(parameter.type);
            literals(parameter.initializer);
          }
        }
      }
    }
    if (ts.isNewExpression(node)) {
      const errorClass = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : name(node.expression);
      if (errorClass && errorClass in FORWARDED_ERRORS) {
        const index = FORWARDED_ERRORS[errorClass];
        if (index !== null) literals(node.arguments?.[index]);
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source);
      // DO jsonError normally takes (context, status, code, message); the
      // transfer router's local helper takes (context, code, message, status).
      if (callee === "jsonError")
        literals(
          node.arguments[
            file === "worker/src/do/routes/transfer-routes.ts" ? 1 : 2
          ],
        );
      if (callee === "errorEnvelope") literals(node.arguments[0]);
      if (callee === "zodValidationError") literals(node.arguments[2]);
      if (callee === "failure" && file === "worker/src/routes/repos.ts")
        literals(node.arguments[2]);
      if (
        callee === "fail" &&
        [
          "ops-sqlite/src/agent-binding-ops.ts",
          "ops-sqlite/src/conversation-ops.ts",
        ].includes(file)
      )
        literals(node.arguments[0]);
      if (callee === "this.deny" && file === "worker/src/d1/runtime-store.ts")
        literals(node.arguments[0]);
    }
    // The validation helper's default is forwarded through a shorthand code.
    if (
      ts.isParameter(node) &&
      name(node.name) === "code" &&
      file === "worker/src/lib/validation.ts"
    )
      literals(node.initializer);
    ts.forEachChild(node, visit);
  }
  // The journal route forwards this helper's return value. Inspect only its
  // declared wire contract: other schema fields are nested Zod diagnostics.
  if (file === "schemas/src/custom-journal.ts") {
    for (const statement of source.statements) {
      if (
        ts.isFunctionDeclaration(statement) &&
        statement.name?.text === "journalValidationCode"
      )
        literals(statement.type);
    }
  } else visit(source);
  return codes;
}

function collectServerEmittedCodes(): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const files = [
    ...["worker", "ops-sqlite", "core"].flatMap((pkg) =>
      collectSourceFiles(join(PACKAGES, pkg, "src")),
    ),
    join(PACKAGES, "schemas/src/custom-journal.ts"),
  ];
  for (const path of files) {
    const file = relative(PACKAGES, path).replaceAll("\\", "/");
    for (const code of collectEmittedCodes(readFileSync(path, "utf8"), file))
      result.set(code, [...(result.get(code) ?? []), file]);
  }
  return result;
}

const SDK_LOCAL_CODES = new Set<string>([
  TILA_ERRORS.UNKNOWN,
  TILA_ERRORS.UNSUPPORTED_CAPABILITY,
  TILA_ERRORS.ARTIFACT_GET_FAILED,
  TILA_ERRORS.ARTIFACT_GET_LATEST_FAILED,
]);

// Keep these tests independent of TILA_ERRORS: deleting a server code from the
// SDK must fail even when no individual endpoint regression exercises it.
describe("SDK / server error-code contract (#592)", () => {
  const server = collectServerEmittedCodes();
  const sdk = new Set<string>(Object.values(TILA_ERRORS));

  it("recognizes every public server code without UNKNOWN normalization", () => {
    const missing = [...server].filter(([code]) => !sdk.has(code));
    expect(
      missing,
      "Server codes missing from the SDK, with source files",
    ).toEqual([]);
    for (const code of server.keys()) expect(toTilaErrorCode(code)).toBe(code);
  });

  it("has a server source for every non-local SDK code", () => {
    expect(
      [...sdk].filter(
        (code) => !SDK_LOCAL_CODES.has(code) && !server.has(code),
      ),
    ).toEqual([]);
  });

  it("has unique wire values and retains the repository authorization constant", () => {
    expect(Object.values(TILA_ERRORS)).toHaveLength(sdk.size);
    expect(
      Object.entries(TILA_ERRORS).filter(
        ([, code]) => code === "token-authz-denied",
      ),
    ).toEqual([["REPO_TOKEN_AUTHZ_DENIED", "token-authz-denied"]]);
  });

  it("retains UNKNOWN for genuinely future codes", () => {
    expect(toTilaErrorCode("some-future-code")).toBe(TILA_ERRORS.UNKNOWN);
  });
});

describe("server error-code collector", () => {
  it("reads the journal validation contract without including nested Zod codes", () => {
    expect([
      ...collectEmittedCodes(
        `const issue = { code: "custom" };
         function journalValidationCode(error: unknown): "payload-too-large" | "validation-error" { return "validation-error"; }`,
        "schemas/src/custom-journal.ts",
      ),
    ]).toEqual(["payload-too-large", "validation-error"]);
  });
  it("reads literals, constants, conditionals and defaults without matching comments or messages", () => {
    const codes = collectEmittedCodes(
      `
      // code: "comment-only"
      const fallback = "default-code";
      const a = { error: { code: disabled ? "disabled" : (other ?? fallback), message: "code: ignored" } };
      const b = { error: { "code": "DO_DESTROY_FAILED" as const } };
    `,
      "worker/src/routes/example.ts",
    );
    expect([...codes].sort()).toEqual([
      "DO_DESTROY_FAILED",
      "default-code",
      "disabled",
    ]);
  });

  it("reads the two jsonError signatures and source-scoped helpers", () => {
    expect([
      ...collectEmittedCodes(
        'jsonError(c, 409, "conflict", "Message")',
        "worker/src/do/routes/record-routes.ts",
      ),
    ]).toEqual(["conflict"]);
    expect([
      ...collectEmittedCodes(
        'jsonError(c, "transfer-conflict", "Message", 409)',
        "worker/src/do/routes/transfer-routes.ts",
      ),
    ]).toEqual(["transfer-conflict"]);
    expect([
      ...collectEmittedCodes(
        'fail("conflict", "Message")',
        "ops-sqlite/src/agent-binding-ops.ts",
      ),
    ]).toEqual(["conflict"]);
    expect([
      ...collectEmittedCodes(
        'fail("internal", "Message")',
        "core/src/other.ts",
      ),
    ]).toEqual([]);
  });

  it("reads forwarded constructors, fixed properties and literal-union declarations", () => {
    expect(
      [
        ...collectEmittedCodes(
          `
      type Codes = "invalid-id" | "no-schema";
      class TemplateInstantiateError extends Error { constructor(public code: Codes) { super(); } }
      class TransferConflictError extends Error { readonly code = "transfer-conflict"; }
      new ArtifactReviewError(409, "review-conflict", "Message");
      new TransferConflictError("Do not interpret this message as a code");
      new OidcDiscoveryError("discovery-invalid", "Internal detail");
    `,
          "ops-sqlite/src/example.ts",
        ),
      ].sort(),
    ).toEqual([
      "invalid-id",
      "no-schema",
      "review-conflict",
      "transfer-conflict",
    ]);
  });

  it("excludes internal occurrences without suppressing public occurrences of the same value", () => {
    for (const file of INTERNAL_CODE_SOURCES.keys())
      expect([
        ...collectEmittedCodes(
          'const diagnostic = { code: "schema-corrupt" };',
          file,
        ),
      ]).toEqual([]);
    expect([
      ...collectEmittedCodes(
        'const response = { error: { code: "schema-corrupt" } };',
        "ops-sqlite/src/error-map.ts",
      ),
    ]).toEqual(["schema-corrupt"]);
  });
});
