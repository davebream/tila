import { type RecordWriteResult, isRecordWriteReceipt } from "@tila/schemas";
import { describe, expect, it, vi } from "vitest";
import { RemoteRecordBackend } from "../../backends/remote";
import { TilaApiError, TilaClient } from "../../client";

/**
 * These tests drive a REAL `TilaClient` over a stubbed `fetch`, so the response
 * schema the backend asks for actually runs. A mocked `client.post` resolves
 * with whatever the test hands it and never exercises that validation, which is
 * how a committed write-only receipt used to surface as "Unexpected response
 * shape" in the remote backend.
 */

const TYPE = "question";
const KEY = "q1/x";

const storedItem = {
  type: TYPE,
  key: KEY,
  schema_version: 3,
  value: { text: "stored by someone else" },
  value_sha256: "a".repeat(64),
  revision: 7,
  archived: 0,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_100_000,
  updated_by: "another-actor",
  tags: ["stored-tag"],
};

const receiptBody = { ok: true, receipt: true, type: TYPE, key: KEY, fence: 4 };
const fullBody = { ok: true, record: storedItem, fence: 4, revision: 7 };

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

function harness(respond: () => Response) {
  const calls: Call[] = [];
  const fetchStub = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({
      method: String(init?.method),
      path: url.pathname,
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined,
    });
    return respond();
  });
  const client = new TilaClient({
    baseUrl: "https://worker.example",
    token: "write-only-credential",
    participantId: "fixture",
    fetch: fetchStub as unknown as typeof globalThis.fetch,
  });
  return { backend: new RemoteRecordBackend(client, "proj"), calls };
}

const base = "/projects/proj/records";

const writes = [
  {
    name: "createRecord",
    status: 201,
    method: "POST",
    path: `${base}/${TYPE}`,
    call: (b: RemoteRecordBackend) =>
      b.createRecord({ type: TYPE, key: KEY, value: { text: "mine" } }),
    body: { key: KEY, value: { text: "mine" } },
  },
  {
    name: "setRecord",
    status: 200,
    method: "PUT",
    path: `${base}/${TYPE}/q1/x`,
    call: (b: RemoteRecordBackend) =>
      b.setRecord({ type: TYPE, key: KEY, value: { text: "mine" }, fence: 3 }),
    body: { value: { text: "mine" }, fence: 3 },
  },
  {
    name: "putRecord",
    status: 200,
    method: "POST",
    path: `${base}/${TYPE}/~/put/q1/x`,
    call: (b: RemoteRecordBackend) =>
      b.putRecord({ type: TYPE, key: KEY, value: { text: "mine" } }),
    body: { value: { text: "mine" } },
  },
] as const;

describe.each(writes)("RemoteRecordBackend.$name write receipt", (write) => {
  it("surfaces a write-only receipt as a distinct result, after exactly one request", async () => {
    const { backend, calls } = harness(() =>
      Response.json(receiptBody, { status: write.status }),
    );

    const result = await write.call(backend);

    expect(isRecordWriteReceipt(result)).toBe(true);
    expect(result).toEqual(receiptBody);
    // The request is the write itself: no read-after-write to recover the row.
    expect(calls).toEqual([
      { method: write.method, path: write.path, body: write.body },
    ]);
  });

  it("carries only the receipt fields, never stored state", async () => {
    // A receipt that (wrongly) arrives with stored fields attached must not
    // pass them on: the caller was not allowed to read them.
    const { backend } = harness(() =>
      Response.json(
        {
          ...receiptBody,
          record: storedItem,
          value: storedItem.value,
          value_sha256: storedItem.value_sha256,
          revision: storedItem.revision,
          updated_by: storedItem.updated_by,
          tags: storedItem.tags,
          created_at: storedItem.created_at,
        },
        { status: write.status },
      ),
    );

    const result = await write.call(backend);

    expect(isRecordWriteReceipt(result)).toBe(true);
    expect(Object.keys(result).sort()).toEqual(
      ["fence", "key", "ok", "receipt", "type"].sort(),
    );
  });

  it("keeps the full row, revision and fence for a credential that can read", async () => {
    const { backend, calls } = harness(() =>
      Response.json(fullBody, { status: write.status }),
    );

    const result = await write.call(backend);

    expect(isRecordWriteReceipt(result)).toBe(false);
    expect(result).toEqual({ ...storedItem, fence: 4 });
    expect(calls).toHaveLength(1);
  });

  it("propagates an error response as an error, not a receipt", async () => {
    const { backend, calls } = harness(() =>
      Response.json(
        {
          ok: false,
          error: {
            code: "stale-fence",
            message: "Fence is stale",
            retryable: false,
          },
        },
        { status: 409 },
      ),
    );

    const failure = await write.call(backend).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(TilaApiError);
    expect(failure).toMatchObject({ status: 409, code: "stale-fence" });
    expect(calls).toHaveLength(1);
  });

  it("still rejects a success response that is neither a record nor a full receipt", async () => {
    // The union widens what is accepted by exactly one shape; it does not turn
    // response validation off.
    for (const malformed of [
      { ok: true, receipt: true, fence: 4 },
      { ok: true, receipt: false, type: TYPE, key: KEY, fence: 4 },
      { ok: true, fence: 4 },
    ]) {
      const { backend } = harness(() =>
        Response.json(malformed, { status: write.status }),
      );
      await expect(write.call(backend)).rejects.toThrow(
        /Unexpected response shape/,
      );
    }
  });
});

describe("RecordWriteResult", () => {
  it("narrows by isRecordWriteReceipt: a receipt has a fence and no revision", async () => {
    const { backend } = harness(() => Response.json(receiptBody));
    const result: RecordWriteResult = await backend.putRecord({
      type: TYPE,
      key: KEY,
      value: {},
    });

    if (!isRecordWriteReceipt(result)) throw new Error("expected a receipt");
    expect(result.fence).toBe(4);
    // @ts-expect-error a receipt carries no revision to read
    expect(result.revision).toBeUndefined();
    // @ts-expect-error a receipt carries no stored value to read
    expect(result.value).toBeUndefined();
  });

  it("narrows to the full row otherwise", async () => {
    const { backend } = harness(() => Response.json(fullBody));
    const result: RecordWriteResult = await backend.putRecord({
      type: TYPE,
      key: KEY,
      value: {},
    });

    if (isRecordWriteReceipt(result)) throw new Error("expected a record");
    expect(result.revision).toBe(7);
    expect(result.fence).toBe(4);
    expect(result.value).toEqual(storedItem.value);
  });
});
