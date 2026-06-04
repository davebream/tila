import { execFile } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openInBrowser } from "../../lib/browser";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile);

describe("openInBrowser", () => {
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    mockExecFile.mockReset();
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
    vi.restoreAllMocks();
  });

  function setPlatform(platform: string) {
    Object.defineProperty(process, "platform", {
      value: platform,
      writable: true,
      configurable: true,
    });
  }

  it("calls execFile with 'open' on darwin", () => {
    setPlatform("darwin");
    openInBrowser("https://example.com");
    expect(mockExecFile).toHaveBeenCalledWith(
      "open",
      ["https://example.com"],
      expect.any(Function),
    );
  });

  it("calls execFile with 'xdg-open' on linux", () => {
    setPlatform("linux");
    openInBrowser("https://example.com");
    expect(mockExecFile).toHaveBeenCalledWith(
      "xdg-open",
      ["https://example.com"],
      expect.any(Function),
    );
  });

  it("calls execFile with 'cmd /c start' on win32", () => {
    setPlatform("win32");
    openInBrowser("https://example.com");
    expect(mockExecFile).toHaveBeenCalledWith(
      "cmd",
      ["/c", "start", "", "https://example.com"],
      expect.any(Function),
    );
  });

  it("logs fallback message when execFile callback receives an error", () => {
    setPlatform("darwin");
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    openInBrowser("https://example.com");

    // Retrieve the callback and invoke it with a simulated error
    const callback = mockExecFile.mock.calls[0][2] as (
      err: Error | null,
    ) => void;
    callback(new Error("spawn ENOENT"));

    expect(consoleSpy).toHaveBeenCalledWith(
      "Could not open browser automatically. Open this URL manually: https://example.com",
    );
  });

  it("does not log when execFile succeeds", () => {
    setPlatform("darwin");
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    openInBrowser("https://example.com");

    const callback = mockExecFile.mock.calls[0][2] as (
      err: Error | null,
    ) => void;
    callback(null);

    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("passes URLs with special characters without shell interpretation", () => {
    setPlatform("linux");
    const url = "https://github.com/settings/apps/new?state=foo&bar=baz";
    openInBrowser(url);
    // execFile is called with the URL as a direct arg (no shell expansion)
    expect(mockExecFile).toHaveBeenCalledWith(
      "xdg-open",
      [url],
      expect.any(Function),
    );
  });
});
