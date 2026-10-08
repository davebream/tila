#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

function isMusl() {
  if (process.platform !== "linux") return false;
  try {
    const report = process.report.getReport();
    if (!report.header.glibcVersionRuntime) return true;
    return false;
  } catch {
    // Fallback: check for Alpine Linux
    try {
      return fs.existsSync("/etc/alpine-release");
    } catch {
      return false;
    }
  }
}

function getPlatformPackage() {
  const platform = process.platform;
  const arch = process.arch;

  let suffix;
  switch (platform) {
    case "darwin":
      suffix = `darwin-${arch}`;
      break;
    case "linux":
      suffix = isMusl() ? `linux-${arch}-musl` : `linux-${arch}`;
      break;
    case "win32":
      suffix = `windows-${arch}`;
      break;
    default:
      return null;
  }

  return `tila-cli-${suffix}`;
}

function getBinaryPath(packageName) {
  const ext = process.platform === "win32" ? ".exe" : "";
  try {
    const pkgJsonPath = require.resolve(`${packageName}/package.json`);
    const pkgDir = path.dirname(pkgJsonPath);
    return path.join(pkgDir, "bin", `tila${ext}`);
  } catch {
    return null;
  }
}

const packageName = getPlatformPackage();

if (!packageName) {
  process.stderr.write(
    `tila: unsupported platform ${process.platform}/${process.arch}. Use the curl-bash installer or download from GitHub Releases.\n`,
  );
  process.exit(1);
}

const binaryPath = getBinaryPath(packageName);

if (!binaryPath || !fs.existsSync(binaryPath)) {
  process.stderr.write(
    `tila: no native binary found for ${process.platform}/${process.arch}. The package ${packageName} may not be installed.\nTry: npm install ${packageName}\nOr use the curl-bash installer: curl -fsSL https://github.com/davebream/tila/releases/latest/download/install.sh | bash\n`,
  );
  process.exit(1);
}

async function main() {
  const root = path.dirname(__dirname);
  const target = packageName.slice("tila-cli-".length);
  const result = spawnSync(binaryPath, process.argv.slice(2), {
    stdio: ["inherit", "inherit", "inherit", "pipe"],
    maxBuffer: 64 * 1024,
    env: { ...process.env, TILA_UPDATE_LAUNCHER: root, TILA_UPDATE_PIPE: "3" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || !result.output[3]?.length) {
    process.exitCode = result.status ?? 1;
    return;
  }
  let json = false;
  try {
    // Load only for updates, before a manager can replace this package on disk.
    const updater = await import("./update.mjs");
    const current = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ).version;
    const request = JSON.parse(result.output[3].toString());
    json = request.json === true;
    if (
      request.version !== 1 ||
      request.current !== current ||
      request.target !== target ||
      typeof request.json !== "boolean"
    )
      throw new Error("Invalid update handoff from native binary.");
    const available = updater.stableVersion(request.discovery?.available);
    if (updater.compareVersions(available, current) <= 0)
      throw new Error("Update handoff attempted a downgrade or reinstall.");
    // Re-establish ownership in the parent; never execute a command/path from IPC.
    const installation = await updater.detectInstallation({
      execPath: binaryPath,
      target,
      launcherRoot: root,
    });
    if (!["npm", "pnpm", "bun"].includes(installation.method))
      throw new Error("Unexpected package manager in update handoff.");
    const discovery = {
      available,
      latest: available,
      notes: `https://github.com/davebream/tila/releases/tag/v${available}`,
    };
    const progress = (message) => {
      if (!message) return;
      process.stderr.write(
        json
          ? `${JSON.stringify({ type: "diagnostic", level: "info", message })}\n`
          : `${message}\n`,
      );
    };
    const updated = await updater.applyManagedUpdate(
      installation,
      current,
      discovery,
      { progress },
    );
    process.stdout.write(
      json
        ? `${JSON.stringify({ ok: true, result: updated })}\n`
        : `${updater.resultText(updated)}\n`,
    );
  } catch (error) {
    const code = error.code ?? "update-failed";
    process.exitCode = code === "network-error" ? 2 : 1;
    process.stderr.write(
      json
        ? `${JSON.stringify({ ok: false, error: { kind: code, message: error.message, retryable: false, ...(error.hint ? { hint: error.hint } : {}) } })}\n`
        : `${error.message}\n`,
    );
  }
}
main().catch((error) => {
  process.stderr.write(`tila: failed to execute binary: ${error.message}\n`);
  process.exitCode = 1;
});
