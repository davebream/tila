import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

/**
 * Tools that have NO local-backend equivalent and therefore require the remote
 * (Cloudflare/HTTP) backend. In local mode (`backend = "local"`) the data layer
 * is the embedded SQLite stack via `tila-sdk/local`; the facade methods these
 * tools map to throw `LocalUnsupportedError` (R2 pre-upload / multipart form
 * uploads have no local equivalent — local consumers use the text-artifact
 * primitives instead).
 *
 * This is a TYPED, test-assertable constant (S1): the local-mode guard
 * ({@link guardRemoteOnlyTools}) reads it to short-circuit these tools with a
 * clear "requires a remote backend" error BEFORE the facade throws a less
 * actionable `LocalUnsupportedError`. Keeping it here (not in a PR-description
 * note) means the throw-path is exercised by tests and self-documents which
 * tools are cloud-bound.
 *
 * Why each member is remote-only:
 *  - `tila_artifact_put`: uploads raw (base64-decoded) bytes via a multipart
 *    form to the Worker's R2-backed artifact store. The local artifact backend
 *    exposes only content-addressed TEXT primitives (`writeText`/`readText`);
 *    `artifacts.upload` throws `LocalUnsupportedError` locally. Local agents
 *    should use `tila_artifact_write_text` instead, which IS local-capable.
 */
export const REMOTE_ONLY_TOOLS = [
  "tila_artifact_put",
] as const satisfies readonly string[];

export type RemoteOnlyTool = (typeof REMOTE_ONLY_TOOLS)[number];

const REMOTE_ONLY_SET: ReadonlySet<string> = new Set(REMOTE_ONLY_TOOLS);

/** True when `name` is a tool that requires the remote backend. */
export function isRemoteOnlyTool(name: string): boolean {
  return REMOTE_ONLY_SET.has(name);
}

/**
 * The clear, no-stack-trace error a remote-only tool throws when invoked under
 * the local backend. Surfaced as an `McpError` (InvalidRequest) so MCP clients
 * see a structured, actionable message rather than a raw exception.
 */
export function remoteOnlyError(name: string): McpError {
  const hint =
    name === "tila_artifact_put"
      ? "Use tila_artifact_write_text to store text artifacts locally."
      : "Switch to a remote tila project to use this tool.";
  return new McpError(
    ErrorCode.InvalidRequest,
    `${name} requires a remote backend (backend = "cloudflare"). It is not available in local mode (backend = "local"). ${hint}`,
  );
}

/**
 * Wrap an {@link McpServer} so that, in local mode, every tool in
 * {@link REMOTE_ONLY_TOOLS} is registered with a handler that throws
 * {@link remoteOnlyError} instead of its real (cloud-bound) implementation.
 *
 * In remote mode this is a transparent pass-through — the original
 * `server.tool` is returned unchanged, so there is zero behavior change for the
 * default cloud path.
 *
 * The wrapper intercepts at registration time (replacing the 4th `server.tool`
 * argument, the handler), so the guard is enforced uniformly regardless of how
 * each tool group calls the facade.
 */
export function guardRemoteOnlyTools(
  server: McpServer,
  mode: "local" | "remote",
): McpServer {
  if (mode === "remote") return server;

  const realTool = server.tool.bind(server) as (...args: unknown[]) => unknown;

  const guarded = (...args: unknown[]): unknown => {
    const name = args[0];
    if (typeof name === "string" && isRemoteOnlyTool(name)) {
      // The handler is always the LAST argument across the McpServer.tool
      // overloads (name, [description], [schema], handler). Replace it with the
      // guard so the tool still REGISTERS (clients can discover it) but rejects
      // when invoked locally.
      const replaced = [...args];
      replaced[replaced.length - 1] = async () => {
        throw remoteOnlyError(name);
      };
      return realTool(...replaced);
    }
    return realTool(...args);
  };

  // Return a proxy that overrides only `.tool`; everything else delegates to the
  // real server (resource/prompt registration, connect, etc.).
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "tool") return guarded;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as McpServer;
}
