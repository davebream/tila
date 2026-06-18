/**
 * Tests for the jsonArg lint contract and JSON output migration.
 *
 * Design note: We cannot dynamically import CLI command modules in Vitest
 * because they transitively import bun:sqlite (backend-local) which is
 * unavailable in Node/Vitest. Instead, we verify the static shape of
 * jsonArg and the console.log(JSON.stringify) migration via output.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonArg, printJson, printJsonSuccess } from "../lib/output";

describe("jsonArg shared arg declaration", () => {
  it("has json key with type 'boolean' and default false", () => {
    expect(jsonArg.json.type).toBe("boolean");
    expect(jsonArg.json.default).toBe(false);
    expect(typeof jsonArg.json.description).toBe("string");
    expect(jsonArg.json.description.length).toBeGreaterThan(0);
  });

  it("is a const object spread-compatible (no prototype pollution)", () => {
    // Spread it into an args object as a leaf subcommand would
    const args = { ...jsonArg, otherArg: { type: "string" as const } };
    expect(args.json).toBeDefined();
    expect(args.otherArg).toBeDefined();
  });
});

describe("printJson emits valid JSON to stdout", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("presence heartbeat site: { ok: true } is valid JSON via printJson", () => {
    printJson({ ok: true });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const out = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(out.ok).toBe(true);
  });

  it("task ready site: { ok: true, entities } via printJson", () => {
    const entities = [{ id: "e1" }, { id: "e2" }];
    printJson({ ok: true, entities });
    const out = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(out.ok).toBe(true);
    expect(out.entities).toHaveLength(2);
  });

  it("search results site: { results } via printJson", () => {
    const results = [{ type: "entity", entity_id: "e1" }];
    printJson({ results });
    const out = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(out.results).toHaveLength(1);
  });

  it("artifact grep site: response object via printJson", () => {
    const response = { truncated: false, results: [] };
    printJson(response);
    const out = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(out.truncated).toBe(false);
  });
});

describe("printJsonSuccess wraps result in CliSuccessEnvelope", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("emits { ok: true, result: <data> } JSON", () => {
    printJsonSuccess({ id: "abc" });
    const out = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(out.ok).toBe(true);
    expect(out.result).toEqual({ id: "abc" });
  });

  it("works with array results", () => {
    printJsonSuccess([1, 2, 3]);
    const out = JSON.parse(String(logSpy.mock.calls[0][0]));
    expect(out.ok).toBe(true);
    expect(out.result).toEqual([1, 2, 3]);
  });
});
