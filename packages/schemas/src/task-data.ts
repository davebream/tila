/**
 * Upper bound on a task's `data`, in UTF-8 bytes of its JSON serialization.
 *
 * The same value applies at the Worker route, the Durable Object route and
 * the shared ops layer (so local and embedded backends refuse identically).
 * It keeps a task far below SQLite's per-value ceiling, where an oversized
 * write used to fail inside the database as a retryable 500.
 */
export const MAX_TASK_DATA_BYTES = 256 * 1024;

const encoder = new TextEncoder();

/**
 * UTF-8 byte length of the JSON a task's data is stored as.
 *
 * This is the canonical-JSON length: sorting keys never changes it. It is
 * measured on the serialization itself rather than on a key-sorted copy,
 * because rebuilding the object through a plain `{}` silently drops an own
 * `__proto__` key, which the stored JSON keeps.
 */
export function taskDataBytes(data: Record<string, unknown>): number {
  return encoder.encode(JSON.stringify(data)).length;
}

/**
 * Refusal text shared by every layer that enforces the bound.
 *
 * `currentBytes` is the stored size when the write is an update: a task that
 * is already over the limit may only be updated to something smaller.
 */
export function taskDataTooLargeMessage(
  bytes: number,
  currentBytes?: number,
): string {
  const limit = `${MAX_TASK_DATA_BYTES} bytes (${MAX_TASK_DATA_BYTES / 1024} KiB) of JSON`;
  if (currentBytes !== undefined && currentBytes > MAX_TASK_DATA_BYTES)
    return `Task data is already ${currentBytes} bytes, over the limit of ${limit}; an update must make it smaller, but this one results in ${bytes} bytes`;
  return `Task data is ${bytes} bytes; task data is limited to ${limit}`;
}
