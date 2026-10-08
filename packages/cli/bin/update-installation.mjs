import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

export function updateError(message, code = "update-failed", hint = undefined) {
  return Object.assign(new Error(hint ? `${message} ${hint}` : message), {
    code,
    hint,
  });
}

export async function canonical(path) {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

export async function executable(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const suffix of process.platform === "win32"
      ? [".exe", ".cmd", ""]
      : [""]) {
      const file = resolve(directory, name + suffix);
      try {
        await access(file, constants.X_OK);
        return file;
      } catch {
        /* Try the next PATH entry. */
      }
    }
  }
  return undefined;
}

// No shell interpolation, including on Windows: invoke the JS entry behind
// npm/pnpm's .cmd shim directly. Bun and Homebrew are native executables/scripts.
export async function runProcess(
  requestedCommand,
  requestedArgs,
  { cwd = homedir(), timeout = 30_000, progress, env = process.env } = {},
) {
  let command = requestedCommand;
  let args = requestedArgs;
  if (process.platform === "win32" && command.endsWith(".cmd")) {
    const name = command.toLowerCase().endsWith("pnpm.cmd") ? "pnpm" : "npm";
    const script = join(
      dirname(command),
      "node_modules",
      name,
      "bin",
      name === "npm" ? "npm-cli.js" : "pnpm.cjs",
    );
    await access(script);
    command = await executable("node");
    if (!command)
      throw updateError(
        "Node is required to run the installed package manager.",
      );
    args = [script, ...args];
  }
  return await new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let failure;
    const timer = setTimeout(() => {
      failure = updateError(
        "The update command timed out. Check the installed version before retrying.",
        "network-error",
      );
      child.kill();
    }, timeout);
    const collect = (chunk, isError) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) {
        failure = updateError(
          "Package manager output exceeded the safety limit.",
        );
        child.kill();
        return;
      }
      const text = chunk.toString();
      if (isError) stderr += text;
      else stdout += text;
      if (progress) progress(text.trim());
    };
    child.stdout.on("data", (chunk) => collect(chunk, false));
    child.stderr.on("data", (chunk) => collect(chunk, true));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (status !== 0)
        return reject(
          updateError(
            `Command failed (${status}): ${stderr.trim().slice(-1500) || stdout.trim().slice(-1500)}`,
            /ETIMEDOUT|ENOTFOUND|ECONN|EAI_AGAIN|429|503/.test(stderr)
              ? "network-error"
              : "update-failed",
          ),
        );
      accept(stdout.trim());
    });
  });
}

export async function platformBinary(root, target) {
  const require = createRequire(
    join((await canonical(root)) ?? root, "package.json"),
  );
  const manifest = require.resolve(`tila-cli-${target}/package.json`);
  return join(
    dirname(manifest),
    "bin",
    target.startsWith("windows") ? "tila.exe" : "tila",
  );
}

export async function detectInstallation({
  execPath = process.execPath,
  target,
  launcherRoot,
  home = homedir(),
  run = runProcess,
  which = executable,
} = {}) {
  if (!/^(darwin|linux|windows)-(arm64|x64)(-musl)?$/.test(target ?? ""))
    throw updateError(
      "This is a source checkout, not an installed tila release.",
      "unsupported-installation",
      "Update the checkout with git, or run an installed tila binary.",
    );
  const path = await canonical(execPath);
  if (!path) throw updateError("Cannot resolve the running tila executable.");
  if (launcherRoot) {
    const root = await canonical(launcherRoot);
    const pkg =
      root && JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    if (
      pkg?.name !== "tila-cli" ||
      (await canonical(await platformBinary(root, target))) !== path
    )
      throw updateError(
        "The npm launcher does not own this executable.",
        "unsupported-installation",
      );
    const candidates = [];
    for (const manager of ["npm", "pnpm", "bun"]) {
      const command = await which(manager);
      if (!command) continue;
      try {
        if (manager === "bun") {
          const bin = await run(command, ["pm", "bin", "-g"], { cwd: home });
          if (
            (await canonical(join(bin, "tila"))) ===
            (await canonical(join(root, "bin", "tila.cjs")))
          )
            candidates.push({
              method: manager,
              command,
              root,
              path,
              target,
              home,
            });
        } else {
          const modules = await run(command, ["root", "-g"], { cwd: home });
          if ((await canonical(join(modules, "tila-cli"))) !== root) continue;
          const prefix =
            manager === "npm"
              ? await run(command, ["prefix", "-g"], { cwd: home })
              : undefined;
          candidates.push({
            method: manager,
            command,
            root: join(modules, "tila-cli"),
            prefix,
            path,
            target,
            home,
          });
        }
      } catch {
        /* An unavailable manager cannot establish ownership. */
      }
    }
    if (candidates.length === 1) return candidates[0];
    throw updateError(
      "This tila package is local, temporary, or its global package manager cannot be identified uniquely.",
      "unsupported-installation",
      "Use the original package manager to update tila-cli. For npx/pnpm dlx/bunx, request tila-cli@latest.",
    );
  }
  // A Homebrew receipt plus the manager's own prefix must both agree.
  const keg = dirname(dirname(path));
  try {
    const receipt = JSON.parse(
      await readFile(join(keg, "INSTALL_RECEIPT.json"), "utf8"),
    );
    const tap = receipt.source?.tap;
    if (tap !== "davebream/tap")
      throw updateError(
        "This Homebrew formula is not the official tila formula.",
        "unsupported-installation",
      );
    const command = await which("brew");
    if (!command)
      throw updateError(
        "Homebrew owns this installation but brew is not on PATH.",
        "unsupported-installation",
      );
    const formula = `${tap}/tila`;
    if (
      (await canonical(
        await run(command, ["--prefix", formula], { cwd: home }),
      )) !== keg
    )
      throw updateError(
        "The available Homebrew does not own this tila installation.",
        "unsupported-installation",
      );
    return { method: "homebrew", command, formula, path, target, home };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const directory = await canonical(join(home, ".tila", "bin"));
  const official =
    directory &&
    join(directory, target.startsWith("windows") ? "tila.exe" : "tila");
  // An alias TO the official binary is fine. An official-path symlink INTO
  // a package manager store must not grant permission to overwrite that store.
  if (official === path) return { method: "standalone", path, target, home };
  throw updateError(
    `Cannot establish ownership of ${path}.`,
    "unsupported-installation",
    "Update through the original installer or package manager. Direct self-update is supported in the official installer's user bin directory.",
  );
}
