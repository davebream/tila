import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

export function inspectTest(source, runtime = false) {
  const errors = [];
  const ast = ts.createSourceFile(
    "test.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const matcher = node.expression.name.text;
      const call = node.expression.expression;
      if (
        ["toBe", "toEqual", "toStrictEqual"].includes(matcher) &&
        ts.isCallExpression(call) &&
        call.expression.getText(ast) === "expect"
      ) {
        const left = call.arguments[0];
        const right = node.arguments[0];
        if (
          left &&
          right &&
          (ts.isLiteralExpression(left) ||
            [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(
              left.kind,
            )) &&
          left.getText(ast) === right.getText(ast)
        )
          errors.push("unconditional placeholder assertion");
      }
    }
    if (
      runtime &&
      ts.isPropertyAccessExpression(node) &&
      ["skip", "todo", "only", "skipIf", "runIf"].includes(node.name.text) &&
      ["it", "test", "describe"].includes(node.expression.getText(ast))
    )
      errors.push(
        "required runtime tests cannot be skipped, TODO, conditional or exclusive",
      );
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return errors;
}

function check(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (
      entry.isDirectory() &&
      !["node_modules", "dist"].includes(entry.name) &&
      !entry.name.startsWith(".")
    )
      check(path);
    else if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)) {
      const errors = inspectTest(
        readFileSync(path, "utf8"),
        path.includes("/runtime/"),
      );
      if (errors.length) throw new Error(`${path}: ${errors.join(", ")}`);
    }
  }
}
if (process.argv[1]?.endsWith("check-test-quality.mjs")) {
  check("packages");
}
