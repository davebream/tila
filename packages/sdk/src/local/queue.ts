import type { AttemptBackend, QueueBackend } from "@tila/core";
import { mapProjectError } from "@tila/ops-sqlite";
import { toTilaErrorCode } from "../error-codes";
import { TilaApiError } from "../errors";
/** Preserve the backend's typed methods while normalizing local domain errors. */
export function localQueueErrors<T extends QueueBackend | AttemptBackend>(
  backend: T,
): T {
  return new Proxy(backend, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        try {
          return await value.apply(target, args);
        } catch (error) {
          const mapped = error instanceof Error ? mapProjectError(error) : null;
          if (mapped)
            throw new TilaApiError(
              mapped.status,
              toTilaErrorCode(mapped.code),
              (error as Error).message,
              mapped.retryable,
            );
          throw error;
        }
      };
    },
  });
}
