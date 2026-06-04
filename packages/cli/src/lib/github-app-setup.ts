import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { RequestListener, Server } from "node:http";
import { createServer } from "node:http";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { openInBrowser } from "./browser";
import { buildManifest } from "./github-app-manifest";

/**
 * GitHub App credentials returned by manifest conversion.
 */
export interface AppCredentials {
  app_id: number;
  slug: string;
  client_id: string;
  client_secret: string;
  pem: string;
  webhook_secret: string;
}

export function loadGithubAppCredentials(dir: string): AppCredentials | null {
  const filePath = join(dir, "github-app.json");
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (
      !parsed.app_id ||
      !parsed.pem ||
      !parsed.client_id ||
      !parsed.client_secret
    ) {
      return null;
    }
    return parsed as AppCredentials;
  } catch {
    return null;
  }
}

export interface ManifestFlowOptions {
  tilaDir: string;
  projectId?: string;
  workerUrl?: string;
  onReady?: (port: number) => void;
}

/**
 * Build a branded status page matching tila's design system.
 * Self-contained inline styles — no external CSS, fonts, or assets.
 *
 * Variants: "success" (green), "error" (red), "info" (blue/neutral).
 */
type StatusVariant = "success" | "error" | "info";

interface StatusPageOptions {
  variant: StatusVariant;
  heading: string;
  message: string;
}

const STATUS_COLORS: Record<StatusVariant, { accent: string; glow: string }> = {
  success: { accent: "#4ade80", glow: "rgba(74, 222, 128, 0.15)" },
  error: { accent: "#f87171", glow: "rgba(248, 113, 113, 0.15)" },
  info: { accent: "#6c8aff", glow: "rgba(108, 138, 255, 0.15)" },
};

const STATUS_ICONS: Record<StatusVariant, string> = {
  success: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`,
  error: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
  info: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
};

function buildStatusPage({
  variant,
  heading,
  message,
}: StatusPageOptions): string {
  const { accent, glow } = STATUS_COLORS[variant];
  const icon = STATUS_ICONS[variant];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${heading} — tila</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{
  background:#0f1117;
  color:#e1e4ed;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  font-size:14px;
  line-height:1.5;
  display:flex;
  align-items:center;
  justify-content:center;
  min-height:100vh;
  padding:24px;
}
.card{
  background:#1a1d27;
  border:1px solid #2a2d3a;
  border-radius:12px;
  padding:48px 32px;
  max-width:400px;
  width:100%;
  text-align:center;
}
.logo{
  color:#6c8aff;
  font-size:22px;
  font-weight:700;
  letter-spacing:-0.03em;
  margin-bottom:24px;
}
.icon{
  color:${accent};
  background:${glow};
  width:56px;
  height:56px;
  border-radius:50%;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  margin-bottom:16px;
}
h1{
  font-size:18px;
  font-weight:600;
  color:#e1e4ed;
  margin-bottom:8px;
}
p{
  color:#8b8fa3;
  font-size:13px;
}
</style>
</head>
<body>
<div class="card">
  <div class="logo">tila</div>
  <div class="icon">${icon}</div>
  <h1>${heading}</h1>
  <p>${message}</p>
</div>
</body>
</html>`;
}

/**
 * Generate the auto-submit HTML form page served at GET /.
 */
function buildFormHtml(manifestJson: string): string {
  const escaped = manifestJson.replace(/'/g, "&#39;");
  return `<!DOCTYPE html>
<html>
<head>
<title>Create GitHub App — tila</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f6f8fa; }
  .card { background: #fff; border: 1px solid #d0d7de; border-radius: 6px; padding: 2rem; max-width: 420px; text-align: center; }
  .card h2 { margin-top: 0; }
  .card p { color: #57606a; line-height: 1.5; }
  .btn { display: inline-block; padding: 0.6rem 1.5rem; background: #2da44e; color: #fff; border: none; border-radius: 6px; font-size: 1rem; cursor: pointer; }
  .btn:hover { background: #2c974b; }
  .note { font-size: 0.85rem; color: #8b949e; margin-top: 1rem; }
  .note a { color: #0969da; }
</style>
</head>
<body>
<div class="card">
  <h2>Create GitHub App</h2>
  <p>This will register a new GitHub App for tila on your account.</p>
  <form id="manifest-form" action="https://github.com/settings/apps/new" method="post">
    <input type="hidden" name="manifest" value='${escaped}' />
    <button type="submit" class="btn">Create GitHub App</button>
  </form>
  <p class="note">Make sure you're <a href="https://github.com/login" target="_blank">signed in to GitHub</a> first.</p>
</div>
</body>
</html>`;
}

const CALLBACK_PATH_RE = /^\/callback\/([a-f0-9]{32})$/;
const CODE_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Create the HTTP request handler for the manifest flow.
 * Extracted for unit-testability.
 *
 * @param state       - 32-char hex nonce embedded in the callback path
 * @param manifestJson - Serialized GitHub App manifest JSON
 * @param tilaDir     - Path to .tila directory for credential storage
 * @param resolve     - Promise resolve for AppCredentials
 * @param reject      - Promise reject
 * @param getServer   - Lazy getter for the Server instance (set after listen)
 * @param getTimeoutId - Lazy getter for the timeout handle
 */
export function createManifestHandler(
  state: string,
  manifestJson: string,
  tilaDir: string,
  resolve: (creds: AppCredentials) => void,
  reject: (err: Error) => void,
  getServer: () => Server | null,
  getTimeoutId: () => NodeJS.Timeout | null,
): RequestListener {
  let codeExchanged = false;

  return async (req, res) => {
    const urlPath = req.url?.split("?")[0] ?? "/";

    // Route 1: GET / — serve the auto-submit form
    if (urlPath === "/") {
      const html = buildFormHtml(manifestJson);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
      return;
    }

    // Route 2: GET /callback/<state>?code=...
    const match = CALLBACK_PATH_RE.exec(urlPath);
    if (match) {
      const extractedState = match[1];

      // Validate state with timing-safe compare
      try {
        const stateOk = timingSafeEqual(
          Buffer.from(extractedState),
          Buffer.from(state),
        );
        if (!stateOk) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Invalid state");
          return;
        }
      } catch {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Invalid state");
        return;
      }

      // Validate code query param
      const qs = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
      const code = qs.get("code");
      if (!code || !CODE_RE.test(code)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing or invalid code parameter");
        return;
      }

      // Guard against double-submission
      if (codeExchanged) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          buildStatusPage({
            variant: "info",
            heading: "Already processed",
            message: "Return to your terminal to continue.",
          }),
        );
        return;
      }
      codeExchanged = true;

      // Exchange code for credentials
      try {
        const exchangeResponse = await fetch(
          `https://api.github.com/app-manifests/${code}/conversions`,
          {
            method: "POST",
            headers: {
              Accept: "application/vnd.github.v3+json",
              "User-Agent": "tila-cli",
            },
          },
        );

        if (!exchangeResponse.ok) {
          const errorText = await exchangeResponse.text();
          throw new Error(
            `GitHub manifest conversion failed: ${exchangeResponse.status} ${exchangeResponse.statusText} - ${errorText}`,
          );
        }

        const credentials = await exchangeResponse.json();

        // Write credentials to .tila/github-app.json with mode 0o600
        mkdirSync(tilaDir, { recursive: true, mode: 0o700 });
        const credPath = join(tilaDir, "github-app.json");
        const credData: AppCredentials = {
          app_id: credentials.id,
          slug: credentials.slug,
          client_id: credentials.client_id,
          client_secret: credentials.client_secret,
          pem: credentials.pem,
          webhook_secret: credentials.webhook_secret,
        };
        writeFileSync(credPath, JSON.stringify(credData, null, 2), {
          mode: 0o600,
        });

        // Serve success page
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          buildStatusPage({
            variant: "success",
            heading: "GitHub App created",
            message: "Return to your terminal to continue setup.",
          }),
        );

        // Cleanup
        const tid = getTimeoutId();
        if (tid) clearTimeout(tid);
        const srv = getServer();
        if (srv) srv.close();

        resolve(credData);
      } catch (error) {
        // Serve error page
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(
          buildStatusPage({
            variant: "error",
            heading: "Setup failed",
            message: "Return to your terminal for details.",
          }),
        );

        const tid = getTimeoutId();
        if (tid) clearTimeout(tid);
        const srv = getServer();
        if (srv) srv.close();

        reject(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }

    // Catch-all: 404
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  };
}

/**
 * Start GitHub App manifest flow.
 * Opens browser to local server which auto-submits the manifest form to GitHub.
 * Handles the callback with code exchange, serves success/error pages,
 * and writes credentials to .tila/github-app.json.
 *
 * @param opts - Options object containing tilaDir and optional projectId
 * @returns App credentials
 */
export async function startManifestFlow(
  opts: ManifestFlowOptions,
): Promise<AppCredentials> {
  const { tilaDir, projectId, workerUrl, onReady } = opts;
  return new Promise((resolve, reject) => {
    let server: Server | null = null;
    let timeoutId: NodeJS.Timeout | null = null;

    // Generate random state nonce (32 hex chars)
    const state = randomBytes(16).toString("hex");

    // Use a mutable ref so the handler captures the final manifest JSON
    // (which depends on the port, known only after listen).
    let finalHandler: RequestListener | null = null;

    server = createServer((req, res) => {
      if (finalHandler) {
        finalHandler(req, res);
      } else {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("Server not ready");
      }
    });

    // Listen on ephemeral port, loopback only
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to get server port"));
        return;
      }

      const port = address.port;
      const callbackUrl = `http://127.0.0.1:${port}/callback/${state}`;

      // Build manifest now that we know the callback URL with state nonce
      const manifest = buildManifest(callbackUrl, workerUrl, projectId);
      const manifestJson = JSON.stringify(manifest);

      // Wire up the real handler with the manifest JSON
      finalHandler = createManifestHandler(
        state,
        manifestJson,
        tilaDir,
        resolve,
        reject,
        () => server,
        () => timeoutId,
      );

      // Notify caller before opening browser so they can display the URL
      if (onReady) onReady(port);

      // Open browser to local server root (which auto-submits the form)
      openInBrowser(`http://127.0.0.1:${port}/`);
    });

    // Set 5-minute timeout
    timeoutId = setTimeout(
      () => {
        if (server) server.close();
        reject(
          new Error(
            "GitHub manifest flow timeout: no code received within 5 minutes",
          ),
        );
      },
      5 * 60 * 1000,
    );

    // Handle server errors
    server.on("error", (error) => {
      if (timeoutId) clearTimeout(timeoutId);
      reject(error);
    });
  });
}

/**
 * Mint a GitHub App JWT for API authentication.
 * Uses RS256 signing with the App's private key.
 *
 * @param appId - GitHub App ID
 * @param pem - RSA private key in PEM format (PKCS#1 or PKCS#8)
 * @returns JWT token valid for 10 minutes
 */
export async function mintAppJwt(appId: number, pem: string): Promise<string> {
  // Parse PEM and import key
  // GitHub returns PKCS#1 format (BEGIN RSA PRIVATE KEY)
  // crypto.subtle needs PKCS#8 format (BEGIN PRIVATE KEY)

  // Detect format
  const isPkcs1 = pem.includes("BEGIN RSA PRIVATE KEY");
  const isPkcs8 = pem.includes("BEGIN PRIVATE KEY");

  if (!isPkcs1 && !isPkcs8) {
    throw new Error("Invalid PEM format: must be PKCS#1 or PKCS#8");
  }

  let pemBody: string;
  if (isPkcs1) {
    pemBody = pem
      .replace(/-----BEGIN RSA PRIVATE KEY-----/, "")
      .replace(/-----END RSA PRIVATE KEY-----/, "")
      .replace(/\s/g, "");
  } else {
    pemBody = pem
      .replace(/-----BEGIN PRIVATE KEY-----/, "")
      .replace(/-----END PRIVATE KEY-----/, "")
      .replace(/\s/g, "");
  }

  const binaryDer = Buffer.from(pemBody, "base64");

  // For PKCS#1, we need to convert to PKCS#8
  // For now, we'll try importing as PKCS#8 first, then fall back to Node's crypto module
  let cryptoKey: CryptoKey;

  try {
    cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      binaryDer,
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256",
      },
      false,
      ["sign"],
    );
  } catch (error) {
    // If PKCS#8 import fails and we have PKCS#1, use Node's crypto module
    if (isPkcs1) {
      // Use Node.js crypto for PKCS#1 -> PKCS#8 conversion
      const { createPrivateKey } = await import("node:crypto");
      const nodeKey = createPrivateKey({
        key: pem,
        format: "pem",
      });
      const pkcs8Der = nodeKey.export({ type: "pkcs8", format: "der" });
      cryptoKey = await crypto.subtle.importKey(
        "pkcs8",
        pkcs8Der,
        {
          name: "RSASSA-PKCS1-v1_5",
          hash: "SHA-256",
        },
        false,
        ["sign"],
      );
    } else {
      throw error;
    }
  }

  // Build JWT claims
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: String(appId),
    iat: now - 60, // 60-second clock-skew buffer (GitHub recommendation)
    exp: now + 600, // 10 minutes
  };

  // Encode header and payload as base64url
  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const message = `${headerB64}.${payloadB64}`;

  // Sign message
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    Buffer.from(message),
  );

  // Encode signature as base64url
  const signatureB64 = Buffer.from(signature).toString("base64url");

  return `${message}.${signatureB64}`;
}

/**
 * Discover GitHub App installation.
 * Polls GitHub API for installations, handles single/multiple/none cases.
 *
 * @param appJwt - GitHub App JWT from mintAppJwt
 * @returns Installation ID and account login
 */
export async function discoverInstallation(
  appJwt: string,
): Promise<{ id: number; account: string }> {
  const startTime = Date.now();
  const timeout = 120 * 1000; // 120 seconds
  const pollInterval = 3 * 1000; // 3 seconds

  while (Date.now() - startTime < timeout) {
    try {
      const response = await fetch("https://api.github.com/app/installations", {
        headers: {
          Accept: "application/vnd.github.v3+json",
          Authorization: `Bearer ${appJwt}`,
          "User-Agent": "tila-cli",
        },
      });

      if (!response.ok) {
        throw new Error(
          `GitHub installations API failed: ${response.status} ${response.statusText}`,
        );
      }

      const installations = await response.json();

      if (Array.isArray(installations) && installations.length > 0) {
        // For now, just return the first installation
        // In production, this would show a picker for multiple installations
        const first = installations[0];
        return {
          id: first.id,
          account: first.account.login,
        };
      }

      // No installations yet, wait and retry
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    } catch (error) {
      // If it's an API error, throw immediately
      if (
        error instanceof Error &&
        error.message.includes("GitHub installations API failed")
      ) {
        throw error;
      }
      // Otherwise, wait and retry
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }

  throw new Error(
    "Installation discovery timeout: no installations found within 120 seconds. " +
      "Please install the GitHub App first.",
  );
}

/**
 * Register GitHub App installation with tila Worker.
 * Posts installation_id to Worker's app-config endpoint.
 *
 * @param workerUrl - The tila Worker base URL
 * @param token - tila API token for authentication
 * @param installationId - GitHub App installation ID
 */
export async function registerWithWorker(
  workerUrl: string,
  token: string,
  installationId: number,
): Promise<void> {
  const response = await fetch(`${workerUrl}/api/auth/github/app-config`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "tila-cli",
    },
    body: JSON.stringify({ installation_id: installationId }),
  });

  if (!response.ok) {
    throw new Error(
      `Worker registration failed: ${response.status} ${response.statusText}`,
    );
  }
}
