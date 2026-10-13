import { useState } from "react";

/**
 * A request whose answer carries a secret (a credential or an invitation).
 * It deliberately bypasses the query client, whose caches keep results, and
 * any persisted draft: pending and error state are local, and the result goes
 * straight to the caller, which keeps the secret in component state only.
 * Nothing is retried automatically, because these writes are not idempotent.
 */
export function useSecretRequest<A, R>(
  send: (args: A) => Promise<R>,
  handlers: {
    onDone: (result: R) => void;
    onError: (error: unknown) => void;
  },
) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return {
    pending,
    error,
    async run(args: A) {
      setPending(true);
      setError(null);
      try {
        const result = await send(args);
        setPending(false);
        handlers.onDone(result);
      } catch (failure) {
        setPending(false);
        setError(failure);
        handlers.onError(failure);
      }
    },
  };
}
