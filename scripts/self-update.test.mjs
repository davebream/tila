import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  canonical,
  detectInstallation,
  runProcess,
} from "../packages/cli/bin/update-installation.mjs";
import {
  applyManagedUpdate,
  checksum,
  compareVersions,
  discoverVersion,
  download,
  latestRelease,
  performUpdate,
  releaseBinary,
  replaceBinary,
  stableVersion,
  withInstallLock,
} from "../packages/cli/bin/update.mjs";

const temporary = await mkdtemp(join(tmpdir(), "tila-update-test-"));
after(() => rm(temporary, { recursive: true, force: true }));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const target = "darwin-arm64";
const base = "https://github.com/davebream/tila/releases/download/v1.2.0/";
async function file(path, content = "binary") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return path;
}
function releaseFixture({
  gzip = true,
  bytes = Buffer.from("verified binary"),
} = {}) {
  const name = `tila-${target}`;
  const compressed = gzipSync(bytes);
  const sums = Buffer.from(
    `${hash(bytes)}  ${name}\n${hash(compressed)}  ${name}.gz\n`,
  );
  const assets = [
    [name, bytes],
    ...(gzip ? [[`${name}.gz`, compressed]] : []),
    ["checksums.txt", sums],
  ];
  const release = {
    version: "1.2.0",
    tag_name: "v1.2.0",
    draft: false,
    prerelease: false,
    assets: assets.map(([name, data]) => ({
      name,
      browser_download_url: base + name,
      digest: `sha256:${hash(data)}`,
    })),
  };
  const responses = new Map(
    assets.map(([name, bytes]) => [base + name, bytes]),
  );
  const fetcher = async (url) =>
    new Response(responses.get(String(url)) ?? JSON.stringify(release));
  return { release, responses, fetcher, bytes };
}

test("stable comparison rejects prereleases, invalid versions and unsafe numbers", () => {
  assert.equal(compareVersions("1.10.0", "1.9.99"), 1);
  assert.equal(compareVersions("v1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("0.9.0", "1.0.0"), -1);
  for (const value of [
    "1.2",
    "01.2.3",
    "1.2.3-rc.1",
    "9007199254740993.0.0",
    "latest",
    undefined,
  ])
    assert.throws(() => stableVersion(value));
});
test("unique valid checksums are mandatory", () => {
  const line = `${hash("x")}  tila`;
  assert.equal(checksum(line, "tila"), hash("x"));
  for (const text of ["", `${line}\n${line}`, `${line}\nbad tila`, "bad tila"])
    assert.throws(() => checksum(text, "tila"), /exactly one/);
});
test("gzip and raw releases verify both digests and checksum entries", async () => {
  for (const gzip of [true, false]) {
    const fixture = releaseFixture({ gzip });
    assert.deepEqual(
      await releaseBinary(fixture.release, target, fixture),
      fixture.bytes,
    );
    const selected = fixture.release.assets[gzip ? 1 : 0];
    fixture.responses.set(
      selected.browser_download_url,
      Buffer.from("corrupted"),
    );
    await assert.rejects(
      releaseBinary(fixture.release, target, fixture),
      /SHA-256/,
    );
  }
  const fixture = releaseFixture();
  fixture.release.assets[0].digest = `sha256:${"0".repeat(64)}`;
  await assert.rejects(
    releaseBinary(fixture.release, target, fixture),
    /SHA-256/,
  );
});
test("missing assets, duplicate assets and invalid release metadata fail closed", async () => {
  const fixture = releaseFixture();
  await assert.rejects(
    releaseBinary(fixture.release, "linux-x64", fixture),
    /missing/,
  );
  fixture.release.assets.push(fixture.release.assets[1]);
  await assert.rejects(
    releaseBinary(fixture.release, target, fixture),
    /ambiguous/,
  );
  fixture.release.prerelease = true;
  await assert.rejects(latestRelease(fixture), /published stable/);
});
test("downloads enforce HTTPS, redirect hosts, size bounds and limited retries", async () => {
  await assert.rejects(download("http://github.com/file"), /untrusted/);
  await assert.rejects(
    download(base, {
      fetcher: async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://example.com/evil" },
        }),
    }),
    /untrusted/,
  );
  await assert.rejects(
    download(base, { limit: 2, fetcher: async () => new Response("large") }),
    /size limit/,
  );
  let attempts = 0;
  await assert.rejects(
    download(base, {
      fetcher: async () => {
        attempts++;
        return new Response(null, { status: 429 });
      },
    }),
    { code: "network-error" },
  );
  assert.equal(attempts, 3);
  attempts = 0;
  await assert.rejects(
    download(base, {
      fetcher: async () => {
        attempts++;
        return new Response(null, { status: 404 });
      },
    }),
  );
  assert.equal(attempts, 1);
});
test("installation detection rejects source, arbitrary paths, and recognizes official symlinks", async () => {
  await assert.rejects(detectInstallation(), {
    code: "unsupported-installation",
  });
  const home = join(temporary, "standalone");
  const execPath = await file(join(home, ".tila/bin/tila"));
  assert.equal(
    (await detectInstallation({ execPath, home, target })).method,
    "standalone",
  );
  const alias = join(home, "alias");
  await symlink(execPath, alias);
  assert.equal(
    (await detectInstallation({ execPath: alias, home, target })).path,
    await canonical(execPath),
  );
  await assert.rejects(
    detectInstallation({
      execPath: await file(join(home, "unknown")),
      home,
      target,
    }),
    /ownership/,
  );
});
test("Homebrew requires both an official receipt and matching manager prefix", async () => {
  const home = join(temporary, "brew");
  const keg = join(home, "Cellar/tila/1.0.0");
  const execPath = await file(join(keg, "bin/tila"));
  await file(
    join(keg, "INSTALL_RECEIPT.json"),
    JSON.stringify({ source: { tap: "davebream/tap" } }),
  );
  const options = {
    execPath,
    home,
    target,
    which: async () => "brew",
    run: async () => keg,
  };
  assert.equal((await detectInstallation(options)).method, "homebrew");
  await assert.rejects(
    detectInstallation({ ...options, which: async () => undefined }),
    /not on PATH/,
  );
  await assert.rejects(
    detectInstallation({ ...options, run: async () => home }),
    /does not own/,
  );
});
async function npmFixture(name) {
  const home = join(temporary, name);
  const modules = join(home, "custom-prefix/node_modules");
  const launcherRoot = join(modules, "tila-cli");
  await file(
    join(launcherRoot, "package.json"),
    JSON.stringify({ name: "tila-cli", version: "1.0.0" }),
  );
  await file(join(launcherRoot, "bin/tila.cjs"));
  await file(
    join(modules, `tila-cli-${target}/package.json`),
    JSON.stringify({ name: `tila-cli-${target}` }),
  );
  const execPath = await file(join(modules, `tila-cli-${target}/bin/tila`));
  return { home, modules, launcherRoot, execPath, target };
}
test("npm and pnpm use matching global roots, never availability alone", async () => {
  const fixture = await npmFixture("npm");
  for (const manager of ["npm", "pnpm"]) {
    const options = {
      ...fixture,
      which: async (name) => (name === manager ? name : undefined),
      run: async (_command, args) =>
        args[0] === "root" ? fixture.modules : dirname(fixture.modules),
    };
    assert.equal((await detectInstallation(options)).method, manager);
    await assert.rejects(
      detectInstallation({ ...options, run: async () => temporary }),
      /local, temporary/,
    );
  }
  await assert.rejects(
    detectInstallation({
      ...fixture,
      which: async (name) => name,
      run: async () => fixture.modules,
    }),
    /uniquely/,
  );
  await assert.rejects(
    detectInstallation({
      ...fixture,
      execPath: await file(join(fixture.home, "unrelated")),
    }),
    /does not own/,
  );
});
test("Bun ownership requires its global launcher to resolve to this package", async () => {
  const fixture = await npmFixture("bun");
  const bin = join(fixture.home, "bun-bin");
  await mkdir(bin);
  await symlink(join(fixture.launcherRoot, "bin/tila.cjs"), join(bin, "tila"));
  assert.equal(
    (
      await detectInstallation({
        ...fixture,
        which: async (name) => (name === "bun" ? name : undefined),
        run: async () => bin,
      })
    ).method,
    "bun",
  );
});
test("Homebrew discovery reports channel lag and pins", async () => {
  const fixture = releaseFixture();
  const discovery = await discoverVersion(
    { method: "homebrew", command: "brew", formula: "davebream/tap/tila" },
    {
      ...fixture,
      run: async (_command, args) =>
        args[0] === "update"
          ? ""
          : JSON.stringify({
              formulae: [
                {
                  full_name: "davebream/tap/tila",
                  versions: { stable: "1.1.0" },
                  pinned: true,
                },
              ],
            }),
    },
  );
  assert.equal(discovery.available, "1.1.0");
  assert.equal(discovery.latest, "1.2.0");
  await assert.rejects(
    applyManagedUpdate({ method: "homebrew" }, "1.0.0", discovery),
    { code: "update-pinned" },
  );
});
test("check and already-newer cases never download or replace binaries", async () => {
  const fixture = releaseFixture();
  const home = join(temporary, "checks");
  const execPath = await file(join(home, ".tila/bin/tila"), "original");
  const calls = [];
  const fetcher = async (url) => {
    calls.push(String(url));
    return fixture.fetcher(url);
  };
  const options = { target, home, execPath, fetcher };
  assert.equal(
    (await performUpdate({ ...options, current: "1.0.0", check: true })).result
      .status,
    "available",
  );
  assert.equal(
    (await performUpdate({ ...options, current: "2.0.0" })).result.status,
    "current",
  );
  assert.ok(calls.every((url) => url.endsWith("/releases/latest")));
  assert.equal(await readFile(execPath, "utf8"), "original");
  assert.deepEqual(await readdir(dirname(execPath)), ["tila"]);
});
test("concurrent updates cannot acquire the same installation lock", async () => {
  const path = join(temporary, "locked");
  await withInstallLock(path, async () => {
    await assert.rejects(
      withInstallLock(path, async () => assert.fail("must not run")),
      { code: "update-locked" },
    );
  });
  await withInstallLock(path, async () => {});
});
test("candidate validation, failed rename and post-install verification retain the old binary", async () => {
  for (const scenario of ["candidate", "rename", "verify"]) {
    const path = await file(join(temporary, scenario, "tila"), "old");
    await chmod(path, 0o755);
    const run = async (binary) =>
      scenario === "candidate" || (scenario === "verify" && binary === path)
        ? "0.9.0"
        : "1.2.0";
    const move = async (from, to) => {
      if (scenario === "rename" && from.endsWith("/tila") && from !== path)
        throw new Error("simulated rename failure");
      await rename(from, to);
    };
    await assert.rejects(
      replaceBinary(path, Buffer.from("new"), "1.2.0", { run, move }),
    );
    assert.equal(await readFile(path, "utf8"), "old");
    assert.deepEqual(await readdir(dirname(path)), ["tila"]);
  }
});
test("manager execution preserves npm prefix and verifies the installed binary", async () => {
  const fixture = await npmFixture("apply");
  const installation = {
    method: "npm",
    command: "npm",
    prefix: dirname(fixture.modules),
    root: fixture.launcherRoot,
    path: fixture.execPath,
    target,
    home: fixture.home,
  };
  const calls = [];
  const result = await applyManagedUpdate(
    installation,
    "1.0.0",
    { available: "1.2.0", latest: "1.2.0", notes: base },
    {
      run: async (command, args) => {
        calls.push([command, args]);
        return command === "npm" ? "" : calls.length === 1 ? "1.0.0" : "1.2.0";
      },
    },
  );
  assert.equal(result.status, "updated");
  assert.deepEqual(calls[1], [
    "npm",
    ["install", "--global", "--prefix", installation.prefix, "tila-cli@1.2.0"],
  ]);
  await assert.rejects(
    applyManagedUpdate(
      installation,
      "1.0.0",
      { available: "1.2.0" },
      { run: async (command) => (command === "npm" ? "" : "1.0.0") },
    ),
    /expected 1.2.0/,
  );
});
test("manager updates refuse to downgrade after a concurrent external upgrade", async () => {
  const fixture = await npmFixture("concurrent-manager");
  const calls = [];
  await assert.rejects(
    applyManagedUpdate(
      {
        method: "npm",
        root: fixture.launcherRoot,
        path: fixture.execPath,
        prefix: dirname(fixture.modules),
        command: "npm",
      },
      "1.0.0",
      { available: "1.2.0" },
      {
        run: async (command) => {
          calls.push(command);
          return "2.0.0";
        },
      },
    ),
    /version changed/,
  );
  assert.deepEqual(calls, [fixture.execPath]);
});
test("a symlink from the official install path into another store is not standalone", async () => {
  const home = join(temporary, "store-link");
  const binary = await file(
    join(home, "node_modules/tila-cli-darwin-arm64/bin/tila"),
  );
  await mkdir(join(home, ".tila/bin"), { recursive: true });
  await symlink(binary, join(home, ".tila/bin/tila"));
  await assert.rejects(
    detectInstallation({ execPath: binary, home, target }),
    /ownership/,
  );
});
test("subprocess failures and timeouts never report success", async () => {
  await assert.rejects(
    runProcess(process.execPath, ["-e", "process.exit(7)"]),
    /Command failed/,
  );
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setTimeout(()=>{},10000)"], {
      timeout: 20,
    }),
    { code: "network-error" },
  );
});
