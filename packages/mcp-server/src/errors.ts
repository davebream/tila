import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { TilaApiError } from "tila-sdk";

/**
 * Map a caught error to an McpError suitable for MCP tool/resource responses.
 * - TilaApiError 4xx -> ErrorCode.InvalidRequest
 * - TilaApiError 5xx -> ErrorCode.InternalError
 * - Network errors -> ErrorCode.InternalError
 *
 * NOTE: Token values are never included in error messages.
 */
export function toMcpError(err: unknown): McpError {
  if (err instanceof TilaApiError) {
    const code =
      err.status >= 500 ? ErrorCode.InternalError : ErrorCode.InvalidRequest;
    const retryHint = err.retryable ? " (retryable)" : "";
    return new McpError(code, `[${err.code}] ${err.message}${retryHint}`);
  }
  if (err instanceof Error) {
    return new McpError(ErrorCode.InternalError, err.message);
  }
  return new McpError(ErrorCode.InternalError, String(err));
}
