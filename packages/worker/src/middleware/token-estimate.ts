import type { MiddlewareHandler } from "hono";

const TOKEN_ESTIMATE_HEADER = "X-Tila-Token-Estimate";
const JSON_CONTENT_TYPE = "application/json";

type HeaderRecord = Record<string, string | string[]>;

function withTokenEstimateHeader(
  headers: HeaderRecord | undefined,
  bodyLength: number,
): HeaderRecord {
  return {
    "Content-Type": JSON_CONTENT_TYPE,
    ...headers,
    [TOKEN_ESTIMATE_HEADER]: String(Math.ceil(bodyLength / 4)),
  };
}

function isJsonResponse(res: Response): boolean {
  return (
    res.headers
      .get("Content-Type")
      ?.toLowerCase()
      .includes(JSON_CONTENT_TYPE) ?? false
  );
}

/**
 * Adds X-Tila-Token-Estimate header to JSON responses.
 * The estimate is ceil(body_length / 4).
 *
 * This is an approximate token count for LLM context budgeting --
 * agents use it for budgeting, not exact accounting.
 */
export function tokenEstimateMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    c.json = ((object: unknown, arg?: unknown, headers?: HeaderRecord) => {
      const body = JSON.stringify(object);
      const bodyLength = body?.length ?? 0;
      return c.body(
        body as never,
        arg as never,
        withTokenEstimateHeader(headers, bodyLength) as never,
      );
    }) as unknown as typeof c.json;

    await next();

    if (c.res.headers.has(TOKEN_ESTIMATE_HEADER) || !isJsonResponse(c.res)) {
      return;
    }

    const contentLength = c.res.headers.get("Content-Length");
    if (!contentLength) return;

    const bodyLength = Number.parseInt(contentLength, 10);
    if (!Number.isFinite(bodyLength) || bodyLength < 0) return;

    const newHeaders = new Headers(c.res.headers);
    newHeaders.set(TOKEN_ESTIMATE_HEADER, String(Math.ceil(bodyLength / 4)));
    c.res = new Response(c.res.body, {
      status: c.res.status,
      statusText: c.res.statusText,
      headers: newHeaders,
    });
  };
}
