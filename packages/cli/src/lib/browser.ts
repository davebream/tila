import { execFile } from "node:child_process";

/**
 * Open a URL in the default system browser.
 * Uses execFile (not exec/shell) to avoid shell injection from URL metacharacters.
 * Fire-and-forget: errors are swallowed and a fallback message is logged.
 *
 * @param url - URL to open
 */
export function openInBrowser(url: string): void {
  const onError = (err: Error | null) => {
    if (err) {
      console.error(
        `Could not open browser automatically. Open this URL manually: ${url}`,
      );
    }
  };

  switch (process.platform) {
    case "darwin":
      execFile("open", [url], onError);
      break;
    case "win32":
      execFile("cmd", ["/c", "start", "", url], onError);
      break;
    default:
      // linux and other unix-like platforms
      execFile("xdg-open", [url], onError);
      break;
  }
}
