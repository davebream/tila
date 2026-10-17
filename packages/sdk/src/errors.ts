import { z } from "zod";
import { type TilaErrorCode, toTilaErrorCode } from "./error-codes";

export class TilaApiError extends Error {
  constructor(
    public status: number,
    public code: TilaErrorCode,
    message: string,
    public retryable: boolean,
    /**
     * Additional error fields the server returned, such as the current
     * `revision` (and `resource`) on a `revision-conflict`.
     */
    public extras: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "TilaApiError";
  }
}

export function isTilaApiError(err: unknown): err is TilaApiError {
  return err instanceof TilaApiError;
}

// Lenient read of the error envelope: keep fields beyond code/message and
// accept envelopes that omit `ok` or `retryable` (some management routes do).
const ApiErrorBodySchema = z.object({
  ok: z.literal(false).optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean().default(false),
    })
    .catchall(z.unknown()),
});

export async function readApiError(res: Response): Promise<TilaApiError> {
  try {
    const parsed = ApiErrorBodySchema.safeParse(await res.json());
    if (parsed.success) {
      const { code, message, retryable, ...extras } = parsed.data.error;
      return new TilaApiError(
        res.status,
        toTilaErrorCode(code),
        message,
        retryable,
        extras,
      );
    }
  } catch {
    // Non-JSON errors have no trusted error envelope.
  }
  return new TilaApiError(
    res.status,
    "UNKNOWN",
    `HTTP ${res.status}: ${res.statusText}`,
    false,
  );
}
