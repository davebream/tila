// Shared by the bundled CLI and dependency-free npm launcher. Keeping this as
// an ES module lets the launcher finish updates after the native child exits.
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  canonical,
  detectInstallation,
  platformBinary,
  runProcess,
  updateError,
} from "./update-installation.mjs";

export { detectInstallation } from "./update-installation.mjs";
const REPOSITORY = "https://api.github.com/repos/davebream/tila";
const LIMIT = 256 * 1024 * 1024;

export function stableVersion(value) {
  if (
    typeof value !== "string" ||
    !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
  )
    throw updateError(
      "The distribution channel returned an invalid stable version.",
    );
  const version = value.replace(/^v/, "");
  if (!version.split(".").every((part) => Number.isSafeInteger(Number(part))))
    throw updateError(
      "The distribution channel returned an invalid stable version.",
    );
  return version;
}
export function compareVersions(a, b) {
  const left = stableVersion(a).split(".").map(Number);
  const right = stableVersion(b).split(".").map(Number);
  for (let i = 0; i < 3; i++)
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}

function trustedUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    ![
      "api.github.com",
      "github.com",
      "release-assets.githubusercontent.com",
      "objects.githubusercontent.com",
    ].includes(url.hostname)
  )
    throw updateError("The release contains an untrusted download URL.");
  return url;
}

export async function download(url, { fetcher = fetch, limit = LIMIT } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const signal = AbortSignal.timeout(120_000);
    try {
      let response;
      let current = trustedUrl(url);
      for (let redirects = 0; redirects <= 5; redirects++) {
        response = await fetcher(current, {
          signal,
          redirect: "manual",
          headers: {
            "User-Agent": "tila-update",
            Accept: "application/octet-stream",
          },
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || redirects === 5)
          throw updateError("Invalid release download redirect.");
        current = trustedUrl(new URL(location, current));
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw updateError(
          `Release download returned HTTP ${response.status}.`,
          response.status === 429 ||
            response.status >= 500 ||
            (response.status === 403 &&
              response.headers.get("x-ratelimit-remaining") === "0")
            ? "network-error"
            : "update-failed",
        );
      }
      if (Number(response.headers.get("content-length")) > limit)
        throw updateError("Release download exceeds the size limit.");
      const chunks = [];
      let size = 0;
      const reader = response.body?.getReader();
      if (!reader) throw updateError("Empty release response.");
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > limit)
            throw updateError("Release download exceeds the size limit.");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      return Buffer.concat(chunks);
    } catch (error) {
      const retryable =
        error.code === "network-error" ||
        error.name === "TimeoutError" ||
        error.name === "AbortError" ||
        error instanceof TypeError;
      if (!retryable) throw error;
      if (attempt === 2)
        throw updateError(
          `Could not fetch the release: ${error.message}`,
          "network-error",
        );
      await new Promise((accept) => setTimeout(accept, 250 * (attempt + 1)));
    }
  }
}

export async function latestRelease(options) {
  const data = JSON.parse(
    (
      await download(`${REPOSITORY}/releases/latest`, {
        ...options,
        limit: 2 * 1024 * 1024,
      })
    ).toString(),
  );
  const version = stableVersion(data.tag_name);
  if (
    data.draft !== false ||
    data.prerelease !== false ||
    !Array.isArray(data.assets)
  )
    throw updateError("GitHub did not return a published stable release.");
  return {
    ...data,
    version,
    notes: `https://github.com/davebream/tila/releases/tag/v${version}`,
  };
}

export function checksum(text, name) {
  const entries = text
    .split(/\r?\n/)
    .map((line) => line.match(/^([a-fA-F0-9]{64})[ \t]+\*?([^\r\n]+)$/))
    .filter((match) => match?.[2] === name);
  // Count malformed/duplicate entries too: ambiguity must never pass verification.
  const named = text
    .split(/\r?\n/)
    .filter(
      (line) => line.trim().split(/\s+/).at(-1)?.replace(/^\*/, "") === name,
    );
  if (entries.length !== 1 || named.length !== 1)
    throw updateError(
      `Expected exactly one valid SHA-256 checksum for ${name}.`,
      "integrity-error",
    );
  return entries[0][1].toLowerCase();
}
function verify(bytes, expected) {
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw updateError(
      "Downloaded binary failed SHA-256 verification.",
      "integrity-error",
    );
}
function asset(release, name, required = true) {
  const matches = release.assets.filter((item) => item.name === name);
  if (matches.length > 1 || (required && matches.length !== 1))
    throw updateError(`Release asset ${name} is missing or ambiguous.`);
  return matches[0];
}
function verifyDigest(bytes, item) {
  if (item.digest != null) {
    if (!/^sha256:[a-fA-F0-9]{64}$/.test(item.digest))
      throw updateError(
        "Release asset has an invalid digest.",
        "integrity-error",
      );
    verify(bytes, item.digest.slice(7).toLowerCase());
  }
}
export async function releaseBinary(release, target, options) {
  const name = `tila-${target}${target.startsWith("windows") ? ".exe" : ""}`;
  const compressed = asset(release, `${name}.gz`, false);
  const selected = compressed ?? asset(release, name);
  const sumsAsset = asset(release, "checksums.txt");
  const sums = await download(sumsAsset.browser_download_url, {
    ...options,
    limit: 1024 * 1024,
  });
  verifyDigest(sums, sumsAsset);
  const expected = checksum(sums.toString(), selected.name);
  const rawExpected = checksum(sums.toString(), name);
  const bytes = await download(selected.browser_download_url, options);
  verify(bytes, expected);
  verifyDigest(bytes, selected);
  const binary = compressed
    ? gunzipSync(bytes, { maxOutputLength: LIMIT })
    : bytes;
  verify(binary, rawExpected);
  const rawAsset = asset(release, name, false);
  if (rawAsset) verifyDigest(binary, rawAsset);
  return binary;
}

export async function withInstallLock(path, operation) {
  const lock = `${path}.update-lock`;
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST")
      throw updateError(
        `Another update may be running. Lock: ${lock}`,
        "update-locked",
        "If the previous updater was interrupted, confirm it has exited before removing the lock directory.",
      );
    throw error;
  }
  try {
    return await operation();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export async function binaryVersion(path, run = runProcess) {
  return stableVersion(
    (await run(path, ["--version"], { timeout: 15_000 })).trim(),
  );
}

// Caller holds the installation lock. Injected filesystem operations support
// failure/rollback tests without weakening the production download trust boundary.
export async function replaceBinary(
  path,
  bytes,
  version,
  { run = runProcess, platform = process.platform, move = rename } = {},
) {
  if (!(await lstat(path)).isFile())
    throw updateError("The resolved executable is no longer a regular file.");
  const mode = (await stat(path)).mode & 0o777;
  const temporary = await mkdtemp(join(dirname(path), ".tila-update-"));
  const candidate = join(temporary, platform === "win32" ? "tila.exe" : "tila");
  const backup = join(temporary, "previous.exe");
  let replaced = false;
  let backedUp = false;
  let preserveBackup = false;
  try {
    const handle = await open(candidate, "wx", mode);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(candidate, mode);
    if ((await binaryVersion(candidate, run)) !== version)
      throw updateError(
        "Downloaded binary reports the wrong version.",
        "integrity-error",
      );
    if (platform === "win32") await move(path, backup);
    else await copyFile(path, backup);
    backedUp = true;
    await move(candidate, path);
    replaced = true;
    if ((await binaryVersion(path, run)) !== version)
      throw updateError(
        "Installed binary reports the wrong version.",
        "integrity-error",
      );
  } catch (error) {
    if (backedUp && (replaced || platform === "win32")) {
      try {
        if (platform === "win32" && replaced) await unlink(path);
        await move(backup, path);
        backedUp = false;
      } catch {
        preserveBackup = true;
        throw updateError(
          `Update failed; restore ${backup} to ${path}.`,
          "update-recovery-required",
        );
      }
    }
    throw error;
  } finally {
    if (!preserveBackup) {
      try {
        await rm(temporary, { recursive: true, force: true });
      } catch {
        /* Windows keeps the old running executable locked until exit.
                 The backup is intentionally left intact; never kill processes. */
      }
    }
  }
}

export async function discoverVersion(
  installation,
  { run = runProcess, fetcher = fetch, progress = () => {} } = {},
) {
  if (installation.method === "standalone") {
    const release = await latestRelease({ fetcher });
    return {
      available: release.version,
      latest: release.version,
      notes: release.notes,
      release,
    };
  }
  if (installation.method === "homebrew") {
    progress("Refreshing Homebrew metadata…");
    await run(installation.command, ["update"], {
      cwd: installation.home,
      timeout: 120_000,
    });
    const info = JSON.parse(
      await run(
        installation.command,
        ["info", "--json=v2", installation.formula],
        { cwd: installation.home },
      ),
    );
    const formula = info.formulae?.find(
      (entry) => entry.full_name === installation.formula,
    );
    if (!formula)
      throw updateError("Homebrew did not return the owning formula.");
    const available = stableVersion(formula.versions?.stable);
    let latest = available;
    try {
      latest = (await latestRelease({ fetcher })).version;
    } catch {
      progress(
        "Could not compare Homebrew with GitHub; using the formula's stable version.",
      );
    }
    return {
      available,
      latest,
      pinned: formula.pinned === true,
      notes: `https://github.com/davebream/tila/releases/tag/v${available}`,
    };
  }
  const args =
    installation.method === "bun"
      ? ["info", "tila-cli", "dist-tags", "--json"]
      : ["view", "tila-cli", "dist-tags", "--json"];
  const tags = JSON.parse(
    await run(installation.command, args, { cwd: installation.home }),
  );
  const available = stableVersion(tags.latest);
  return {
    available,
    latest: available,
    notes: `https://github.com/davebream/tila/releases/tag/v${available}`,
  };
}

export function updateResult(
  installation,
  current,
  discovery,
  status,
  installed = current,
) {
  return {
    status,
    currentVersion: current,
    availableVersion: discovery.available,
    installedVersion: installed,
    latestVersion: discovery.latest,
    installationMethod: installation.method,
    executablePath: installation.path,
    releaseNotes: discovery.notes,
    channelBehind: compareVersions(discovery.available, discovery.latest) < 0,
  };
}

export async function applyManagedUpdate(
  installation,
  current,
  discovery,
  { run = runProcess, progress = () => {} } = {},
) {
  if (discovery.pinned)
    throw updateError(
      "Homebrew has pinned tila. Unpin it explicitly before updating.",
      "update-pinned",
    );
  const args =
    installation.method === "homebrew"
      ? ["upgrade", installation.formula]
      : installation.method === "npm"
        ? [
            "install",
            "--global",
            "--prefix",
            installation.prefix,
            `tila-cli@${stableVersion(discovery.available)}`,
          ]
        : ["add", "--global", `tila-cli@${stableVersion(discovery.available)}`];
  // Lock beside the stable package/opt entry, not inside a versioned store path
  // which the manager may unlink as part of the upgrade.
  const lockPath = installation.root
    ? join(dirname(installation.root), "tila-cli")
    : join(installation.home, ".tila-homebrew-update");
  return await withInstallLock(lockPath, async () => {
    if ((await binaryVersion(installation.path, run)) !== current)
      throw updateError(
        "The installed version changed during this check; run tila update again.",
      );
    progress(
      `Updating via ${installation.method}: ${current} → ${discovery.available}`,
    );
    await run(installation.command, args, {
      cwd: installation.home,
      timeout: 600_000,
      progress,
    });
    let path;
    if (installation.method === "homebrew")
      path = join(
        await run(installation.command, ["--prefix", installation.formula], {
          cwd: installation.home,
        }),
        "bin",
        "tila",
      );
    else path = await platformBinary(installation.root, installation.target);
    const installed = await binaryVersion(path, run);
    if (
      compareVersions(installed, discovery.available) < 0 ||
      compareVersions(installed, current) <= 0
    )
      throw updateError(
        `The manager finished but tila reports ${installed}; expected ${discovery.available}.`,
        "update-verification-failed",
      );
    return updateResult(
      { ...installation, path: (await canonical(path)) ?? path },
      current,
      discovery,
      "updated",
      installed,
    );
  });
}

export async function performUpdate({
  current,
  target,
  launcherRoot,
  check = false,
  execPath = process.execPath,
  home,
  run = runProcess,
  fetcher = fetch,
  which,
  progress = () => {},
}) {
  stableVersion(current);
  const installation = await detectInstallation({
    execPath,
    target,
    launcherRoot,
    home,
    run,
    which,
  });
  progress(`Checking ${installation.method} installation (${current})…`);
  const discovery = await discoverVersion(installation, {
    run,
    fetcher,
    progress,
  });
  const newer = compareVersions(discovery.available, current) > 0;
  if (check || !newer)
    return {
      result: updateResult(
        installation,
        current,
        discovery,
        discovery.pinned && newer ? "pinned" : newer ? "available" : "current",
      ),
    };
  if (["npm", "pnpm", "bun"].includes(installation.method))
    return { handoff: { version: 1, current, target, discovery } };
  if (installation.method === "homebrew")
    return {
      result: await applyManagedUpdate(installation, current, discovery, {
        run,
        progress,
      }),
    };
  return {
    result: await withInstallLock(installation.path, async () => {
      // Revalidate after acquiring the lock; another updater may have just finished.
      if ((await binaryVersion(installation.path, run)) !== current)
        throw updateError(
          "The installed version changed during this check; run tila update again.",
        );
      progress(`Downloading tila ${discovery.available}…`);
      const bytes = await releaseBinary(discovery.release, target, { fetcher });
      if ((await binaryVersion(installation.path, run)) !== current)
        throw updateError(
          "The installed version changed during the download; run tila update again.",
        );
      progress("Verifying and installing the update…");
      await replaceBinary(installation.path, bytes, discovery.available, {
        run,
      });
      return updateResult(
        installation,
        current,
        discovery,
        "updated",
        discovery.available,
      );
    }),
  };
}

export function resultText(result) {
  const text =
    result.status === "updated"
      ? `Updated tila ${result.currentVersion} → ${result.installedVersion} via ${result.installationMethod}.`
      : result.status === "available"
        ? `tila ${result.availableVersion} is available (installed: ${result.currentVersion}). Run tila update.`
        : result.status === "pinned"
          ? `tila ${result.availableVersion} is available, but the Homebrew formula is pinned.`
          : `tila ${result.currentVersion} is current for ${result.installationMethod}.`;
  return `${text}${result.channelBehind ? `\nThis channel is behind GitHub (${result.latestVersion}); no installation method was changed.` : ""}\n${result.releaseNotes}`;
}
