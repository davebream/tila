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

const result = spawnSync(binaryPath, process.argv.slice(2), {
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  process.stderr.write(
    `tila: failed to execute binary: ${result.error.message}\n`,
  );
  process.exit(1);
}

process.exit(result.status ?? 1);
