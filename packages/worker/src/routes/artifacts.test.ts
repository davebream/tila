import { describe, expect, it, vi } from "vitest";
import { callPointerWithRetry, compensateAndRespond } from "./artifacts";

function mockStub(responses: Array<Response | Error>): DurableObjectStub {
  let callIndex = 0;
  return {
    fetch: vi.fn(async () => {
      const response = responses[callIndex++];
      if (response instanceof Error) throw response;
      return response;
    }),
  } as unknown as DurableObjectStub;
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const POINTER_PAYLOAD = {
  r2_key: "sources/abc123.md",
  resource: null,
  kind: "log",
  sha256: "abc123",
  bytes: 100,
  fence: null,
  mime_type: "text/markdown",
  produced_at: Date.now(),
  produced_by: "test-agent",
  expires_at: null,
  actor: "test-agent",
  search_title: null,
  search_body_text: null,
  actor_token_id: "tok_123",
};

describe("callPointerWithRetry", () => {
  it("retries on throw and succeeds", async () => {
    const stub = mockStub([
      new Error("DO routing error"),
      jsonResponse({ ok: true }),
    ]);

    const result = await callPointerWithRetry(stub, POINTER_PAYLOAD, undefined);

    expect(result.ok).toBe(true);
    expect(result.response?.status).toBe(200);
    expect(stub.fetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 5xx and succeeds on second attempt", async () => {
    const stub = mockStub([
      jsonResponse(
        { ok: false, error: { code: "internal", retryable: true } },
        500,
      ),
      jsonResponse({ ok: true }),
    ]);

    const result = await callPointerWithRetry(stub, POINTER_PAYLOAD, undefined);

    expect(result.ok).toBe(true);
    expect(result.response?.status).toBe(200);
    expect(stub.fetch).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on 4xx (deterministic failure)", async () => {
    const stub = mockStub([
      jsonResponse(
        {
          ok: false,
          error: {
            code: "undeclared-artifact-kind",
            message: "kind 'foo' not declared",
            retryable: false,
          },
        },
        422,
      ),
    ]);

    const result = await callPointerWithRetry(stub, POINTER_PAYLOAD, undefined);

    expect(result.ok).toBe(false);
    expect(result.response?.status).toBe(422);
    expect(stub.fetch).toHaveBeenCalledTimes(1);
  });

  it("returns failure when both attempts throw", async () => {
    const stub = mockStub([
      new Error("DO routing error"),
      new Error("DO routing error again"),
    ]);

    const result = await callPointerWithRetry(stub, POINTER_PAYLOAD, undefined);

    expect(result.ok).toBe(false);
    expect(result.response).toBeNull();
    if (!result.ok) {
      expect(result.threw).toBe(true);
    }
    expect(stub.fetch).toHaveBeenCalledTimes(2);
  });

  it("returns failure when both attempts return 5xx", async () => {
    const stub = mockStub([
      jsonResponse(
        { ok: false, error: { code: "internal", retryable: true } },
        500,
      ),
      jsonResponse(
        { ok: false, error: { code: "internal", retryable: true } },
        502,
      ),
    ]);

    const result = await callPointerWithRetry(stub, POINTER_PAYLOAD, undefined);

    expect(result.ok).toBe(false);
    expect(result.response?.status).toBe(502);
    if (!result.ok) {
      expect(result.threw).toBe(false);
    }
    expect(stub.fetch).toHaveBeenCalledTimes(2);
  });

  it("returns success on first call without retrying", async () => {
    const stub = mockStub([jsonResponse({ ok: true })]);

    const result = await callPointerWithRetry(stub, POINTER_PAYLOAD, undefined);

    expect(result.ok).toBe(true);
    expect(result.response?.status).toBe(200);
    expect(stub.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("upload route: 4xx forwarding", () => {
  it("forwards DO 422 error to client without retry", async () => {
    const doErrorBody = {
      ok: false,
      error: {
        code: "undeclared-artifact-kind",
        message: "kind 'foo' not declared in tila.schema.toml",
        retryable: false,
      },
    };
    const stub = mockStub([jsonResponse(doErrorBody, 422)]);

    const result = await callPointerWithRetry(stub, POINTER_PAYLOAD, undefined);

    expect(result.ok).toBe(false);
    const body = await result.response?.json();
    expect(body).toEqual(doErrorBody);
    expect(result.response?.status).toBe(422);
  });
});

describe("compensateAndRespond", () => {
  it("returns 502 upload-failed when R2 delete succeeds (blob cleaned up)", async () => {
    const mockR2 = { delete: vi.fn().mockResolvedValue(undefined) };

    const result = await compensateAndRespond(mockR2, "sources/abc123.md");

    expect(result.status).toBe(502);
    expect(result.body.ok).toBe(false);
    expect(result.body.error.code).toBe("upload-failed");
    expect(result.body.error.retryable).toBe(true);
    // upload-failed must NOT include r2Key -- blob was cleaned up
    expect(result.body.error).not.toHaveProperty("r2Key");
    expect(mockR2.delete).toHaveBeenCalledWith("sources/abc123.md");
  });

  it("returns 500 pointer-registration-failed with r2Key when R2 delete also fails", async () => {
    const mockR2 = {
      delete: vi.fn().mockRejectedValue(new Error("R2 delete failed")),
    };

    const result = await compensateAndRespond(mockR2, "sources/abc123.md");

    expect(result.status).toBe(500);
    expect(result.body.ok).toBe(false);
    expect(result.body.error.code).toBe("pointer-registration-failed");
    expect(result.body.error.retryable).toBe(true);
    // pointer-registration-failed MUST include r2Key -- blob exists, client needs recovery key
    expect(result.body.error.r2Key).toBe("sources/abc123.md");
    expect(mockR2.delete).toHaveBeenCalledWith("sources/abc123.md");
  });

  it("does not include r2Key in upload-failed response body", async () => {
    const mockR2 = { delete: vi.fn().mockResolvedValue(undefined) };

    const result = await compensateAndRespond(
      mockR2,
      "produced/task-1/def456.bin",
    );

    expect(result.body.error.code).toBe("upload-failed");
    expect("r2Key" in result.body.error).toBe(false);
  });
});
