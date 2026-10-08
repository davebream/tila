import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";

const temporary = await mkdtemp(join(tmpdir(), "tila-native-update-"));
after(() => rm(temporary, { recursive: true, force: true }));
const extension = process.platform === "win32" ? ".exe" : "";
const target = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const engine = resolve("packages/cli/bin/update.mjs");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function invoke(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    timeout: 120_000,
    ...options,
  });
}
function success(result) {
  assert.equal(
    result.status,
    0,
    `${result.error ?? ""}\n${result.stderr}\n${result.stdout}`,
  );
  return result.stdout.trim();
}
async function file(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
const oldSource = join(temporary, "old.ts");
const newSource = join(temporary, "new.ts");
await file(
  oldSource,
  `
import { performUpdate } from ${JSON.stringify(engine)};
import { readFileSync, writeFileSync, writeSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("1.0.0"); process.exit(0); }
const fixture = process.env.TILA_NATIVE_FIXTURE;
try {
  const data = fixture ? JSON.parse(readFileSync(fixture, "utf8")) : null;
  const response = await performUpdate({ current: "1.0.0", target: ${JSON.stringify(target)},
    home: data?.home, launcherRoot: process.env.TILA_UPDATE_LAUNCHER,
    check: process.argv.includes("--check"),
    ...(data ? { fetcher: async (url) => new Response(String(url).endsWith("/releases/latest") ? JSON.stringify(data.release) : readFileSync(data.files[String(url)])) } : {}) });
  if (response.handoff) {
    writeFileSync(process.env.TILA_NATIVE_PID, String(process.pid));
    writeSync(3, JSON.stringify({ ...response.handoff, json: true }));
  } else console.log(JSON.stringify({ ok: true, result: response.result }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
`,
);
await file(newSource, 'console.log("1.2.0");\n');
const oldBinary = join(temporary, `old${extension}`);
const newBinary = join(temporary, `new${extension}`);
for (const [source, output] of [
  [oldSource, oldBinary],
  [newSource, newBinary],
])
  success(invoke("bun", ["build", "--compile", source, "--outfile", output]));
const newBytes = await readFile(newBinary);

test("native executable updates itself, then executes the new version (gzip and raw)", async () => {
  for (const compressed of [true, false]) {
    const home = join(temporary, compressed ? "gzip" : "raw");
    const installed = join(home, ".tila/bin", `tila${extension}`);
    await mkdir(dirname(installed), { recursive: true });
    await copyFile(oldBinary, installed);
    await chmod(installed, 0o755);
    const name = `tila-${target}${extension}`;
    const raw = join(home, name);
    const gz = join(home, `${name}.gz`);
    const sums = join(home, "checksums.txt");
    await writeFile(raw, newBytes);
    await writeFile(gz, gzipSync(newBytes));
    await writeFile(
      sums,
      `${hash(newBytes)}  ${name}\n${hash(await readFile(gz))}  ${name}.gz\n`,
    );
    const assets = [raw, sums, ...(compressed ? [gz] : [])];
    const files = {};
    const release = {
      tag_name: "v1.2.0",
      draft: false,
      prerelease: false,
      assets: [],
    };
    for (const path of assets) {
      const name = path.split(/[\\/]/).at(-1);
      const url = `https://github.com/davebream/tila/releases/download/v1.2.0/${name}`;
      files[url] = path;
      release.assets.push({
        name,
        browser_download_url: url,
        digest: `sha256:${hash(await readFile(path))}`,
      });
    }
    const fixture = join(home, "fixture.json");
    await writeFile(fixture, JSON.stringify({ home, release, files }));
    const env = { ...process.env, TILA_NATIVE_FIXTURE: fixture };
    const checked = JSON.parse(
      success(invoke(installed, ["--check"], { env })),
    );
    assert.equal(checked.result.status, "available");
    assert.equal(success(invoke(installed, ["--version"])), "1.0.0");
    const originalSums = await readFile(sums);
    await writeFile(sums, "corrupted checksums");
    const rejected = invoke(installed, [], { env });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /SHA-256/);
    assert.equal(success(invoke(installed, ["--version"])), "1.0.0");
    await writeFile(sums, originalSums);
    const updated = JSON.parse(success(invoke(installed, [], { env })));
    assert.equal(updated.result.installedVersion, "1.2.0");
    assert.equal(success(invoke(installed, ["--version"])), "1.2.0");
    assert.ok(
      !(await readdir(dirname(installed))).includes(
        `tila${extension}.update-lock`,
      ),
    );
  }
});

test("npm launcher releases the old executable before delegating and keeps JSON clean", async () => {
  const home = join(temporary, "managed");
  const modules = join(home, "prefix/node_modules");
  const root = join(modules, "tila-cli");
  await cp(resolve("packages/cli/bin"), join(root, "bin"), { recursive: true });
  await file(
    join(root, "package.json"),
    JSON.stringify({ name: "tila-cli", version: "1.0.0" }),
  );
  const platformRoot = join(modules, `tila-cli-${target}`);
  await file(
    join(platformRoot, "package.json"),
    JSON.stringify({ name: `tila-cli-${target}` }),
  );
  const installed = join(platformRoot, "bin", `tila${extension}`);
  await mkdir(dirname(installed));
  await copyFile(oldBinary, installed);
  await chmod(installed, 0o755);
  const shimDirectory = join(home, "shims");
  const pidFile = join(home, "pid");
  const managerSource = `#!${process.execPath}\nconst fs = require("node:fs");
const args = process.argv.slice(2);
if(args[0] === "root") console.log(${JSON.stringify(modules)});
else if(args[0] === "prefix") console.log(${JSON.stringify(dirname(modules))});
else if(args[0] === "view") console.log(JSON.stringify({latest:"1.2.0"}));
else if(args[0] === "install") {
  const pid = Number(fs.readFileSync(${JSON.stringify(pidFile)}, "utf8"));
  let alive = true; try { process.kill(pid,0); } catch { alive = false; }
  if(alive) throw new Error("native child still running");
  if(args.join("|") !== ${JSON.stringify(["install", "--global", "--prefix", dirname(modules), "tila-cli@1.2.0"].join("|"))}) throw new Error("wrong update arguments");
  fs.copyFileSync(${JSON.stringify(newBinary)}, ${JSON.stringify(installed)});
  console.log("manager progress, never JSON stdout");
} else process.exit(3);
`;
  await file(join(shimDirectory, "npm"), managerSource);
  await chmod(join(shimDirectory, "npm"), 0o755);
  await file(join(shimDirectory, "npm.cmd"), "@echo off\r\n");
  await file(
    join(shimDirectory, "node_modules/npm/bin/npm-cli.js"),
    managerSource,
  );
  const env = {
    ...process.env,
    PATH: `${shimDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
    TILA_NATIVE_PID: pidFile,
    TILA_NATIVE_FIXTURE: "",
    TILA_UPDATE_LAUNCHER: "untrusted inherited value",
  };
  const run = invoke(
    process.execPath,
    [join(root, "bin/tila.cjs"), "update", "--json"],
    { env },
  );
  const result = JSON.parse(success(run));
  assert.equal(result.result.status, "updated");
  assert.equal(result.result.installationMethod, "npm");
  for (const line of run.stderr.trim().split("\n"))
    assert.equal(JSON.parse(line).type, "diagnostic");
  assert.equal(success(invoke(installed, ["--version"])), "1.2.0");
});
