import { ErrorEnvelopeSchema } from "@tila/schemas";
import { type TilaErrorCode, toTilaErrorCode } from "./error-codes";

export class TilaApiError extends Error {
  constructor(
    public status: number,
    public code: TilaErrorCode,
    message: string,
    public retryable: boolean,
  ) {
    super(message);
    this.name = "TilaApiError";
  }
}

export function isTilaApiError(err: unknown): err is TilaApiError {
  return err instanceof TilaApiError;
}

export async function readApiError(res: Response): Promise<TilaApiError> {
  try {
    const parsed = ErrorEnvelopeSchema.safeParse(await res.json());
    if (parsed.success) {
      const { code, message, retryable } = parsed.data.error;
      return new TilaApiError(
        res.status,
        toTilaErrorCode(code),
        message,
        retryable,
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
