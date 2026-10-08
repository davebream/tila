import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { binaryName, digest, run, targets } from "./release-common.mjs";
import { verifyRelease } from "./release-verify.mjs";

const directory = resolve(process.argv[2] || ".release");
const mode = process.argv[3] || "consumer";
const target =
  process.argv[4] ||
  `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
assert.ok(targets.includes(target), `Unsupported target ${target}`);
const sqliteVersion = process.env.RELEASE_SQLITE_VERSION || "13.0.3";
assert.match(
  sqliteVersion,
  /^\d+\.\d+\.\d+$/,
  "Expected an exact SQLite version",
);
const manifest = verifyRelease(directory, process.env.RELEASE_SHA);
const temporary = mkdtempSync(join(tmpdir(), "tila-release-smoke-"));
const cleanEnv = {
  ...process.env,
  TILA_HOME: join(temporary, "home"),
  TILA_API_TOKEN: "",
  TILA_INSTANCE: "",
  TILA_PROJECT_ID: "",
  TILA_LIFECYCLE_KEY: "",
  TILA_PARTICIPANT_ID: "release-smoke",
  TILA_MCP_TOOLS: "all",
};

function localConfig(cwd) {
  mkdirSync(join(cwd, ".tila"), { recursive: true });
  writeFileSync(
    join(cwd, ".tila/config.toml"),
    `project_id="release-smoke"\nbackend="local"\nschema_version=1\ntila_version=${JSON.stringify(manifest.version)}\ncreated_at="2026-01-01T00:00:00Z"\n[local]\ndb_path=${JSON.stringify(join(cwd, "project.db"))}\nartifacts_path=${JSON.stringify(join(cwd, "artifacts"))}\norg="release-smoke"\n`,
  );
}
function cliSmoke(command, prefix = []) {
  const cwd = join(temporary, `cli-${prefix.length ? "npm" : "binary"}`);
  localConfig(cwd);
  const call = (...args) =>
    run(command, [...prefix, ...args], { cwd, env: cleanEnv, timeout: 30_000 });
  assert.ok(call("--version").includes(manifest.version));
  assert.match(call("--help"), /tila/i);
  assert.match(
    call(
      "task",
      "new",
      "Release persistence",
      "--id",
      "release-task",
      "--json",
    ),
    /release-task/,
  );
  // A second process must read the first process's persisted write.
  const fetched = call("task", "show", "release-task", "--json");
  assert.match(fetched, /release-task/);
  assert.match(fetched, /Release persistence/);
}
async function mcpSmoke(cwd) {
  localConfig(cwd);
  const child = spawn(
    process.execPath,
    [join(cwd, "node_modules/tila-mcp-server/dist/index.js")],
    { cwd, env: cleanEnv, stdio: ["pipe", "pipe", "pipe"] },
  );
  let buffer = "";
  let stderr = "";
  const pending = new Map();
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        pending.get(message.id)?.(message);
      } catch {
        /* diagnostics are not protocol replies */
      }
    }
  });
  const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
  const request = (id, method, params) =>
    new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} timed out: ${stderr}`));
      }, 30_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        pending.delete(id);
        message.error
          ? reject(new Error(JSON.stringify(message.error)))
          : resolveRequest(message.result);
      });
      send({ jsonrpc: "2.0", id, method, params });
    });
  try {
    const result = await request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "release-smoke", version: manifest.version },
    });
    assert.ok(result.serverInfo);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const tools = await request(2, "tools/list", {});
    assert.ok(tools.tools.some((tool) => tool.name === "tila_task_create"));
  } finally {
    const closed = once(child, "close");
    child.kill();
    await closed;
  }
}

async function installerSmoke(binary) {
  const assets = join(directory, "binaries");
  const home = join(temporary, "installer-home");
  mkdirSync(home, { recursive: true });
  if (process.platform === "win32") {
    // Run the shipped installer against local release files, isolating its
    // user-PATH update exactly as the existing installer tests do.
    const script = readFileSync(join(assets, "install.ps1"), "utf8").replace(
      '[Environment]::SetEnvironmentVariable("PATH", "$userPath;$InstallDir", "User")',
      "$null = $userPath",
    );
    const fixture = join(temporary, "install-fixture.ps1");
    writeFileSync(
      fixture,
      `function Invoke-WebRequest { param($Uri, $OutFile, [switch]$UseBasicParsing) Copy-Item (Join-Path $env:TILA_TEST_ASSETS ([IO.Path]::GetFileName($Uri))) $OutFile }\n${script}`,
    );
    run("pwsh", ["-NoProfile", "-File", fixture], {
      env: {
        ...cleanEnv,
        USERPROFILE: home,
        TILA_TEST_ASSETS: assets,
        TILA_VERSION: `v${manifest.version}`,
      },
      timeout: 60_000,
    });
  } else {
    const bin = join(temporary, "installer-bin");
    mkdirSync(bin);
    const curl = join(bin, "curl");
    writeFileSync(
      curl,
      `#!${process.execPath}\nconst fs=require('node:fs'),p=require('node:path'); const args=process.argv.slice(2); const name=args.at(-1).split('/').at(-1); const source=p.join(process.env.TILA_TEST_ASSETS,name); if(!fs.existsSync(source))process.exit(22); fs.copyFileSync(source,args[args.indexOf('-o')+1]); if(args.includes('-w'))process.stdout.write('200');\n`,
      { mode: 0o755 },
    );
    run("sh", [join(assets, "install.sh")], {
      env: {
        ...cleanEnv,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        TILA_TEST_ASSETS: assets,
        TILA_VERSION: `v${manifest.version}`,
      },
      timeout: 60_000,
    });
  }
  const installed = join(
    home,
    ".tila/bin",
    process.platform === "win32" ? "tila.exe" : "tila",
  );
  assert.equal(
    digest(readFileSync(installed)),
    digest(readFileSync(binary)),
    "Installer must install the tested target bytes",
  );
  assert.ok(
    run(installed, ["--version"], { env: cleanEnv }).includes(manifest.version),
  );
}

try {
  if (mode === "binary") {
    const binary = join(directory, "binaries", binaryName(target));
    chmodSync(binary, 0o755);
    cliSmoke(binary);
    await installerSmoke(binary);
  } else {
    assert.equal(mode, "consumer");
    const cwd = join(temporary, "consumer");
    mkdirSync(cwd);
    writeFileSync(
      join(cwd, "package.json"),
      '{"name":"tila-release-consumer","private":true,"type":"module"}\n',
    );
    const packages = manifest.packages.filter((pkg) =>
      [
        "tila-sdk",
        "tila-mcp-server",
        "tila-cli",
        `tila-cli-${target}`,
      ].includes(pkg.name),
    );
    run(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        ...packages.map((pkg) => join(directory, pkg.file)),
        `better-sqlite3@${sqliteVersion}`,
      ],
      { cwd, env: cleanEnv, timeout: 300_000 },
    );
    for (const pkg of packages) {
      const installed = realpathSync(join(cwd, "node_modules", pkg.name));
      assert.ok(
        installed.startsWith(realpathSync(cwd)),
        "Consumer must not resolve a workspace link",
      );
      assert.equal(
        JSON.parse(readFileSync(join(installed, "package.json"), "utf8"))
          .version,
        manifest.version,
      );
    }
    // Resolve through each shipped package so an incompatible nested driver
    // cannot silently escape coverage. Loading keyring checks the native binary
    // without reading or writing the runner's credential store.
    const nativeSmoke = join(cwd, "native-smoke.mjs");
    writeFileSync(
      nativeSmoke,
      `import assert from 'node:assert/strict'; import {createRequire} from 'node:module'; const require=createRequire(import.meta.url); for(const name of ['tila-sdk','tila-mcp-server']) { const consumer=createRequire(require.resolve(name)); assert.equal(consumer('better-sqlite3/package.json').version,${JSON.stringify(sqliteVersion)},name+' SQLite version'); const db=new (consumer('better-sqlite3'))(':memory:'); assert.equal(db.prepare('select 42 as value').get().value,42); db.close(); if(name==='tila-mcp-server') assert.equal(typeof consumer('@napi-rs/keyring').Entry,'function'); }\n`,
    );
    run(process.execPath, [nativeSmoke], {
      cwd,
      env: cleanEnv,
      timeout: 60_000,
    });
    const smoke = join(cwd, "sdk-smoke.mjs");
    writeFileSync(
      smoke,
      `import assert from 'node:assert/strict'; import {createRequire} from 'node:module'; import {join} from 'node:path'; import * as esm from 'tila-sdk'; const cjs=createRequire(import.meta.url)('tila-sdk'); for(const [name,mod] of [['esm',esm],['cjs',cjs]]) { assert.equal(typeof mod.createTila,'function'); const config={project_id:'release',backend:'local',local:{db_path:join(process.cwd(),name+'.db'),artifacts_path:join(process.cwd(),name+'-artifacts'),org:'release'},schema_version:1,tila_version:${JSON.stringify(manifest.version)},created_at:'2026-01-01T00:00:00Z'}; let api=await mod.createTila(config); await api.tasks.create(name,'task',{title:name}); api.close(); api=await mod.createTila(config); assert.equal((await api.tasks.get(name)).entity.data.title,name); api.close(); }\n`,
    );
    run(process.execPath, [smoke], { cwd, env: cleanEnv, timeout: 60_000 });
    await mcpSmoke(cwd);
    cliSmoke(process.execPath, [
      join(cwd, "node_modules/tila-cli/bin/tila.cjs"),
    ]);
  }
  console.log(
    `Passed ${mode} smoke tests: ${target}, Node ${process.version}${mode === "consumer" ? `, SQLite ${sqliteVersion}` : ""}, ${manifest.revision}`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
