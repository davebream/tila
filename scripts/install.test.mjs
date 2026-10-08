import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

for (const scenario of [
  "compressed",
  "musl",
  "legacy",
  "checksum",
  "corrupt",
  "server-error",
  "missing-assets",
  "missing-checksum",
]) {
  test(`POSIX installer: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "tila-install-"));
    try {
      const bin = join(root, "bin");
      const assets = join(root, "assets");
      await mkdir(bin);
      await mkdir(assets);
      const name = `tila-${scenario === "musl" ? "linux" : process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}${scenario === "musl" ? "-musl" : ""}`;
      if (scenario === "musl") {
        await writeFile(
          join(bin, "uname"),
          `#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo ${process.arch === "arm64" ? "aarch64" : "x86_64"};; esac\n`,
          { mode: 0o755 },
        );
        await writeFile(join(bin, "ldd"), "#!/bin/sh\necho musl\n", {
          mode: 0o755,
        });
      }
      const bytes = Buffer.from("#!/bin/sh\necho 0.0.0-test\n");
      const compressed =
        scenario === "corrupt" ? Buffer.from("not gzip") : gzipSync(bytes);
      if (scenario !== "missing-assets")
        await writeFile(join(assets, name), bytes);
      if (!["legacy", "missing-assets"].includes(scenario))
        await writeFile(join(assets, `${name}.gz`), compressed);
      const hash = (value) => createHash("sha256").update(value).digest("hex");
      await writeFile(
        join(assets, "checksums.txt"),
        scenario === "missing-checksum"
          ? `${hash(bytes)}  ${name}\n`
          : `${hash(bytes)}  ${name}\n${scenario === "checksum" ? "0".repeat(64) : hash(compressed)}  ${name}.gz\n`,
      );
      await writeFile(
        join(bin, "curl"),
        `#!${process.execPath}\nconst fs=require('node:fs'),p=require('node:path');const a=process.argv.slice(2);const dest=a[a.indexOf('-o')+1];const name=a.at(-1).split('/').at(-1);const exists=fs.existsSync(p.join(process.env.TILA_TEST_ASSETS,name));if(name.endsWith('.gz')&&process.env.TILA_TEST_SCENARIO==='server-error'){process.stdout.write('503');process.exit(0)}if(exists)fs.copyFileSync(p.join(process.env.TILA_TEST_ASSETS,name),dest);if(a.includes('-w'))process.stdout.write(exists?'200':'404');else if(!exists)process.exit(22);\n`,
        { mode: 0o755 },
      );
      const result = spawnSync("sh", [resolve("scripts/install.sh")], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          PATH: `${bin}:${process.env.PATH}`,
          TILA_VERSION: "v0.0.0-test",
          TILA_TEST_ASSETS: assets,
          TILA_TEST_SCENARIO: scenario,
        },
      });
      if (["compressed", "legacy", "musl"].includes(scenario)) {
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(await readFile(join(root, ".tila/bin/tila")), bytes);
      } else {
        assert.notEqual(result.status, 0);
        await assert.rejects(readFile(join(root, ".tila/bin/tila")), {
          code: "ENOENT",
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test(
  "npm shim hands arguments to the retained raw platform binary",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "tila-npm-handoff-"));
    try {
      const musl =
        process.platform === "linux" &&
        !process.report.getReport().header.glibcVersionRuntime;
      const suffix = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}${musl ? "-musl" : ""}`;
      const pkg = join(root, "node_modules", `tila-cli-${suffix}`);
      await mkdir(join(pkg, "bin"), { recursive: true });
      await writeFile(
        join(pkg, "package.json"),
        JSON.stringify({ name: `tila-cli-${suffix}`, version: "0.0.0" }),
      );
      await writeFile(
        join(pkg, "bin/tila"),
        `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));`,
        { mode: 0o755 },
      );
      await writeFile(
        join(root, "tila.cjs"),
        await readFile(resolve("packages/cli/bin/tila.cjs")),
      );
      const result = spawnSync(
        process.execPath,
        [join(root, "tila.cjs"), "task", "list", "--json"],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), ["task", "list", "--json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
