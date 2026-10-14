// Release-only: TypeScript is already a root dev dependency. This parser is
// never imported by the CLI or included in its distributed binaries.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const FULL_COMMIT = /^[0-9a-f]{40}$/;
const IDENTITY = ["PRODUCT_VERSION", "BUILD_COMMIT"];
const PAYLOAD_OVERRIDES = [
  "TILA_WORKER_DIST",
  "TILA_UI_DIST",
  "TILA_MIGRATIONS_DIR",
];

export function withoutPayloadOverrides(env) {
  const clean = { ...env };
  for (const name of PAYLOAD_OVERRIDES) delete clean[name];
  return clean;
}

// Bounded contract, checked against pinned Wrangler 4.149.0's UTF-8,
// non-minified ESM output (a top-level health.get registration):
// each identity has one top-level string-literal declaration (including a
// multi-declarator var/let/const statement), and exactly one other identifier
// occurrence: the corresponding property in the direct c.json return of the
// single .get("/health", (c) => { return c.json({...}); }) registration.
// TypeScript decodes JS identifier/string escapes. No evaluation, alias tracing,
// computed identity, shadowing, mutations, spreads or renamed/minified bindings
// are accepted. A changed bundler/health contract must fail closed for review.
export function workerIdentity(source) {
  const ast = ts.createSourceFile(
    "worker.js",
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  );
  assert.equal(
    ast.parseDiagnostics.length,
    0,
    "Worker must parse as JavaScript",
  );
  const occurrences = new Map(IDENTITY.map((name) => [name, []]));
  const healthRoutes = [];
  function visit(node) {
    if (ts.isIdentifier(node) && occurrences.has(node.text))
      occurrences.get(node.text).push(node);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "get" &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === "/health"
    )
      healthRoutes.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(healthRoutes.length, 1, "Worker must have one /health route");
  const route = healthRoutes[0];
  const handler = route.arguments[1];
  assert.ok(
    route.arguments.length === 2 &&
      ts.isExpressionStatement(route.parent) &&
      route.parent.parent === ast &&
      ts.isIdentifier(route.expression.expression) &&
      route.expression.expression.text === "health" &&
      ts.isArrowFunction(handler) &&
      handler.parameters.length === 1 &&
      ts.isIdentifier(handler.parameters[0].name) &&
      !handler.parameters[0].initializer &&
      !handler.parameters[0].dotDotDotToken &&
      ts.isBlock(handler.body) &&
      handler.body.statements.length === 1 &&
      ts.isReturnStatement(handler.body.statements[0]),
    "Worker /health must directly return its identity",
  );
  const response = handler.body.statements[0].expression;
  assert.ok(
    response &&
      ts.isCallExpression(response) &&
      ts.isPropertyAccessExpression(response.expression) &&
      ts.isIdentifier(response.expression.expression) &&
      response.expression.expression.text === handler.parameters[0].name.text &&
      response.expression.name.text === "json" &&
      response.arguments.length === 1 &&
      ts.isObjectLiteralExpression(response.arguments[0]),
    "Worker /health must return a literal JSON object",
  );
  const properties = response.arguments[0].properties;
  assert.ok(
    properties.every(
      (property) =>
        ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)),
    ),
    "Worker /health properties must be explicit and unambiguous",
  );
  const identity = {};
  for (const [name, key] of [
    ["PRODUCT_VERSION", "version"],
    ["BUILD_COMMIT", "commit"],
  ]) {
    const references = occurrences.get(name);
    assert.equal(references.length, 2, `Worker ${name} must be unambiguous`);
    const declaration = references[0].parent;
    assert.ok(
      ts.isVariableDeclaration(declaration) &&
        declaration.name === references[0] &&
        ts.isVariableDeclarationList(declaration.parent) &&
        ts.isVariableStatement(declaration.parent.parent) &&
        declaration.parent.parent.parent === ast &&
        !declaration.type &&
        declaration.initializer &&
        ts.isStringLiteral(declaration.initializer),
      `Worker ${name} must have one top-level string literal`,
    );
    const fields = properties.filter((property) => property.name.text === key);
    assert.equal(fields.length, 1, `Worker /health must have one ${key}`);
    assert.ok(
      fields[0].initializer === references[1],
      `Worker /health ${key} must reference ${name}`,
    );
    identity[key] = declaration.initializer.text;
  }
  assert.match(
    identity.commit,
    FULL_COMMIT,
    "Worker BUILD_COMMIT must be full 40-hex",
  );
  assert.equal(
    identity.commit.length,
    40,
    "Worker BUILD_COMMIT must be full 40-hex",
  );
  return identity;
}

// Called for the raw binary, installed binary and npm wrapper. Read the staged
// module itself; the outer/inner manifests and CLI version cannot prove this.
export function assertDeployPayload(output, manifest) {
  assert.equal(
    typeof manifest.revision,
    "string",
    "Release revision is required",
  );
  assert.match(
    manifest.revision,
    FULL_COMMIT,
    "Release revision must be full 40-hex",
  );
  assert.equal(
    manifest.revision.length,
    40,
    "Release revision must be full 40-hex",
  );
  assert.ok(
    typeof manifest.version === "string" && manifest.version.length > 0,
    "Release version is required",
  );
  const { result } = JSON.parse(output);
  assert.equal(result.version, manifest.version, "Deploy payload version");
  assert.equal(result.source, "embedded", "Deploy payload source");
  assert.deepEqual(
    result.overrides,
    [],
    "Deploy payload must have no overrides",
  );
  assert.ok(result.migrations.count > 0, "Deploy payload has D1 migrations");
  assert.ok(result.ui.indexHtml, "Deploy payload has the UI build");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(
    readFileSync(result.worker),
  );
  const identity = workerIdentity(source);
  assert.equal(
    identity.commit,
    manifest.revision,
    "Worker BUILD_COMMIT mismatch",
  );
  assert.equal(
    identity.version,
    manifest.version,
    "Worker PRODUCT_VERSION mismatch",
  );
}
