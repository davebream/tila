import { createHash } from "node:crypto";
import * as fs from "node:fs";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const {
  DeployPayloadError,
  embeddedPayloadRoot,
  parseManifest,
  resetStagedPayloadForTests,
  stageEmbeddedPayload,
  stagePayload,
} = await import("../../lib/deploy-payload");

const sha256 = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const FILES: Record<string, string> = {
  "worker/index.js": "export default { fetch() {} };\n",
  "ui/dist/index.html": "<!doctype html>\n",
  "ui/dist/assets/app.js": "console.log(1);\n",
  "migrations/global/0001_init.sql": "CREATE TABLE t (a);\n",
};

let temp: string;

function writePayload(
  version = "1.2.3",
  files: Record<string, string> = FILES,
): string {
  const source = join(temp, `source-${version}`);
  const digests: Record<string, string> = {};
  for (const [key, content] of Object.entries(files)) {
    const path = join(source, ...key.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    digests[key] = sha256(content);
  }
  writeFileSync(
    join(source, "manifest.json"),
    JSON.stringify({ version, files: digests }),
  );
  return source;
}

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "tila-payload-test-"));
  resetStagedPayloadForTests();
});

afterEach(() => {
  rmSync(temp, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.mocked(fs.renameSync).mockClear();
});

describe("stagePayload()", () => {
  it("extracts every listed file into a versioned cache directory", () => {
    const cacheRoot = join(temp, "cache");
    const staged = stagePayload({
      sourceRoot: writePayload(),
      cacheRoot,
      version: "1.2.3",
    });

    expect(staged.root.startsWith(join(cacheRoot, "1.2.3-"))).toBe(true);
    expect(staged.workerMain).toBe(join(staged.root, "worker", "index.js"));
    expect(staged.uiDist).toBe(join(staged.root, "ui", "dist"));
    expect(staged.migrationsDir).toBe(
      join(staged.root, "migrations", "global"),
    );
    for (const [key, content] of Object.entries(FILES)) {
      expect(readFileSync(join(staged.root, ...key.split("/")), "utf8")).toBe(
        content,
      );
    }
    // Only the staged version remains; no staging directories leak.
    expect(readdirSync(cacheRoot)).toEqual([staged.root.split(/[\\/]/).at(-1)]);
  });

  it("reuses a verified cache and ignores files wrangler adds", () => {
    const cacheRoot = join(temp, "cache");
    const sourceRoot = writePayload();
    const first = stagePayload({ sourceRoot, cacheRoot, version: "1.2.3" });
    writeFileSync(join(first.root, "worker", "wrangler.tila.toml"), "x");
    mkdirSync(join(first.root, "worker", ".wrangler"));

    vi.mocked(fs.renameSync).mockClear();
    const second = stagePayload({ sourceRoot, cacheRoot, version: "1.2.3" });

    expect(second.root).toBe(first.root);
    expect(fs.renameSync).not.toHaveBeenCalled();
    expect(existsSync(join(first.root, "worker", "wrangler.tila.toml"))).toBe(
      true,
    );
  });

  it("rebuilds a cache whose files were modified", () => {
    const cacheRoot = join(temp, "cache");
    const sourceRoot = writePayload();
    const first = stagePayload({ sourceRoot, cacheRoot, version: "1.2.3" });
    writeFileSync(join(first.workerMain), "tampered");

    const second = stagePayload({ sourceRoot, cacheRoot, version: "1.2.3" });

    expect(readFileSync(second.workerMain, "utf8")).toBe(
      FILES["worker/index.js"],
    );
  });

  it("rejects an embedded file that does not match its digest", () => {
    const sourceRoot = writePayload();
    writeFileSync(join(sourceRoot, "worker", "index.js"), "tampered");
    const cacheRoot = join(temp, "cache");

    expect(() =>
      stagePayload({ sourceRoot, cacheRoot, version: "1.2.3" }),
    ).toThrow(/worker\/index\.js does not match its digest/);
    expect(readdirSync(cacheRoot)).toEqual([]);
  });

  it("rejects a payload built for another CLI version", () => {
    expect(() =>
      stagePayload({
        sourceRoot: writePayload("1.2.2"),
        cacheRoot: join(temp, "cache"),
        version: "1.2.3",
      }),
    ).toThrow(/payload version 1\.2\.2 does not match CLI version 1\.2\.3/);
  });

  it("explains a missing manifest", () => {
    expect(() =>
      stagePayload({
        sourceRoot: join(temp, "nothing"),
        cacheRoot: join(temp, "cache"),
        version: "1.2.3",
      }),
    ).toThrow(DeployPayloadError);
  });

  it("uses the winner's copy when another process stages first", () => {
    const cacheRoot = join(temp, "cache");
    const sourceRoot = writePayload();
    vi.mocked(fs.renameSync).mockImplementationOnce((from, to) => {
      // Another process finished renaming its own copy into place first.
      cpSync(String(from), String(to), { recursive: true });
      const error = new Error("exists") as NodeJS.ErrnoException;
      error.code = "ENOTEMPTY";
      throw error;
    });

    const staged = stagePayload({ sourceRoot, cacheRoot, version: "1.2.3" });

    expect(readFileSync(staged.workerMain, "utf8")).toBe(
      FILES["worker/index.js"],
    );
    expect(readdirSync(cacheRoot).filter((e) => e.startsWith("."))).toEqual([]);
  });

  it("prunes payloads staged for other versions", () => {
    const cacheRoot = join(temp, "cache");
    stagePayload({
      sourceRoot: writePayload("1.2.2"),
      cacheRoot,
      version: "1.2.2",
    });
    const current = stagePayload({
      sourceRoot: writePayload("1.2.3"),
      cacheRoot,
      version: "1.2.3",
    });

    expect(readdirSync(cacheRoot)).toEqual([
      current.root.split(/[\\/]/).at(-1),
    ]);
  });
});

describe("parseManifest()", () => {
  const encode = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));
  const digest = "a".repeat(64);

  it("accepts POSIX relative paths", () => {
    expect(
      parseManifest(
        encode({ version: "1.0.0", files: { "ui/dist/a.js": digest } }),
      ).files,
    ).toEqual({ "ui/dist/a.js": digest });
  });

  it.each([
    "../escape.js",
    "/absolute.js",
    "ui\\dist\\a.js",
    "ui//a.js",
    "manifest.json",
  ])("rejects unsafe path %s", (path) => {
    expect(() =>
      parseManifest(encode({ version: "1.0.0", files: { [path]: digest } })),
    ).toThrow(/unsafe path/);
  });

  it("rejects invalid digests and empty file lists", () => {
    expect(() =>
      parseManifest(encode({ version: "1.0.0", files: { "a.js": "nope" } })),
    ).toThrow(/invalid digest/);
    expect(() =>
      parseManifest(encode({ version: "1.0.0", files: {} })),
    ).toThrow(/lists no files/);
  });
});

describe("embedded payload detection", () => {
  it("returns null outside a compiled binary", () => {
    expect(embeddedPayloadRoot()).toBeNull();
    expect(stageEmbeddedPayload(join(temp, "cache"), "1.2.3")).toBeNull();
  });

  it("needs a bunfs module directory, not only the standalone flag", () => {
    vi.stubGlobal("Bun", { isStandaloneExecutable: true });
    // Vitest has no import.meta.dir. Provisioning tests cover the compiled
    // path through a module seam; release smoke covers the real binary.
    expect(embeddedPayloadRoot()).toBeNull();
  });
});
