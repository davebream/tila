import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentOutput, diagnostic, withOutput } from "../../lib/output";
import * as p from "../../lib/prompts";

describe("shared prompt rendering", () => {
  const originalIsTTY = Object.getOwnPropertyDescriptor(
    process.stderr,
    "isTTY",
  );
  let chunks: string[];
  let stdout: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    chunks = [];
    vi.stubEnv("CI", "");
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", "1");
    Object.defineProperty(process.stderr, "isTTY", {
      value: true,
      configurable: true,
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((_chunk, ...args) => {
        const callback = args.find((arg) => typeof arg === "function");
        if (typeof callback === "function") callback();
        return true;
      });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (originalIsTTY)
      Object.defineProperty(process.stderr, "isTTY", originalIsTTY);
    else Reflect.deleteProperty(process.stderr, "isTTY");
  });

  it.each([
    ["info", 34],
    ["success", 32],
    ["step", 32],
    ["warn", 33],
    ["warning", 33],
    ["error", 31],
  ] as const)(
    "renders %s with its Clack status color on stderr",
    (method, color) => {
      p.log[method]("Status detail");
      const output = chunks.join("");
      expect(output).toContain(`\u001b[${color}m`);
      expect(stripVTControlCharacters(output)).toContain("Status detail");
      if (method !== "error") expect(output).not.toContain("\u001b[31m");
      expect(stdout).not.toHaveBeenCalled();
    },
  );

  it("renders notes and headings and preserves green health-check symbols", () => {
    p.intro("Doctor");
    p.note("\u001b[32m✓\u001b[39m Worker reachable", "Health check");
    p.log.message(["First detail", "Second detail"]);
    p.outro("Checks complete");
    const output = chunks.join("");
    expect(output).toContain("\u001b[32m✓\u001b[39m");
    expect(stripVTControlCharacters(output)).toMatch(
      /Doctor[\s\S]*Health check[\s\S]*✓ Worker reachable[\s\S]*First detail[\s\S]*Second detail[\s\S]*Checks complete/,
    );
    expect(output).toContain("┌");
    expect(output).toContain("└");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("renders cancellation with Clack's error color", () => {
    p.cancel("Cancelled");
    expect(chunks.join("")).toContain("\u001b[31m");
    expect(stripVTControlCharacters(chunks.join(""))).toContain("Cancelled");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("keeps informational diagnostics neutral and retains terminal styling", () => {
    diagnostic("Health check");
    diagnostic("\u001b[32m✓\u001b[39m Worker reachable");
    expect(chunks.join("")).toBe(
      "Health check\n\u001b[32m✓\u001b[39m Worker reachable\n",
    );
    expect(stdout).not.toHaveBeenCalled();
  });

  it.each(["redirected", "CI", "NO_COLOR", "empty NO_COLOR"])(
    "uses plain output for %s even with FORCE_COLOR enabled",
    (mode) => {
      if (mode === "redirected")
        Object.defineProperty(process.stderr, "isTTY", {
          value: false,
          configurable: true,
        });
      if (mode === "CI") vi.stubEnv("CI", "1");
      if (mode === "NO_COLOR") vi.stubEnv("NO_COLOR", "1");
      if (mode === "empty NO_COLOR") vi.stubEnv("NO_COLOR", "");
      p.intro("Doctor");
      p.note("\u001b[32m✓\u001b[39m Healthy", "Health check");
      p.log.success("All passed");
      p.log.warn("Warning");
      p.log.error("Error");
      p.cancel("Cancelled");
      p.outro("Complete");
      const spinner = p.spinner();
      spinner.start("Checking");
      spinner.stop("Done");
      diagnostic("\u001b[34mDetails\u001b[39m");
      expect(chunks.join("")).toBe(
        "Doctor\nHealth check\n✓ Healthy\nAll passed\nWarning\nError\nCancelled\nComplete\nChecking\nDone\nDetails\n",
      );
      expect(stdout).not.toHaveBeenCalled();
    },
  );

  it("preserves JSON diagnostics and leaves stdout as a single success envelope", async () => {
    await withOutput({ json: true }, async () => {
      p.note("\u001b[32m✓\u001b[39m Healthy", "Health check");
      p.log.success("All passed");
      p.log.warn("Warning");
      p.log.error("Error");
      p.cancel("Cancelled");
      const spinner = p.spinner();
      spinner.start("Checking");
      spinner.stop("Done");
      expect(currentOutput()?.diagnostics).toEqual([
        "Health check\n✓ Healthy",
        "All passed",
        "Warning",
        "Error",
        "Cancelled",
        "Checking",
        "Done",
      ]);
    });
    const output = chunks.join("");
    expect(output).not.toContain("\u001b");
    expect(
      output
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(
      [
        "Health check\n✓ Healthy",
        "All passed",
        "Warning",
        "Error",
        "Cancelled",
        "Checking",
        "Done",
      ].map((message) => ({ type: "diagnostic", level: "info", message })),
    );
    expect(stdout).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(stdout.mock.calls[0][0]))).toMatchObject({
      ok: true,
      result: {},
    });
  });

  it("avoids Bun's implicit red console.error styling", () => {
    const outputPath = fileURLToPath(
      new URL("../../lib/output.ts", import.meta.url),
    );
    const tsconfig = fileURLToPath(
      new URL("../../../../../tsconfig.json", import.meta.url),
    );
    const result = spawnSync(
      "bun",
      [
        "--tsconfig-override",
        tsconfig,
        "-e",
        `
      import { diagnostic } from ${JSON.stringify(outputPath)};
      Object.defineProperty(process.stderr, "isTTY", { value: true });
      console.error("Error control");
      diagnostic("Health check passed");
    `,
      ],
      { encoding: "utf8", env: process.env },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("\u001b[31mError control");
    expect(result.stderr).toContain("\nHealth check passed\n");
    expect(result.stderr).not.toContain("\u001b[31mHealth check passed");
  });
});
