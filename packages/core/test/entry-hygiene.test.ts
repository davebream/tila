import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Worker, Durable Object and SDK bundles import `@tila/core`'s main entry.
 * The `yaml` library must stay behind `@tila/core/definition-yaml` so it never
 * reaches them.
 */
describe("main entry", () => {
  it("never imports yaml or the YAML adapter", () => {
    const src = resolve(__dirname, "../src");
    const offenders = readdirSync(src, { recursive: true })
      .map(String)
      .filter((file) => file.endsWith(".ts") && file !== "definition-yaml.ts")
      .filter((file) => {
        const text = readFileSync(resolve(src, file), "utf8");
        return /from ["'](?:yaml|\.\/definition-yaml)["']/.test(text);
      });
    expect(offenders).toEqual([]);
  });
});
