import { CREDENTIAL_PRESETS } from "@tila/schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TilaClient } from "../client";
import { createServiceAccountMethods } from "../service-accounts";
import { createTokenMethods } from "../tokens";

describe("credential HTTP contracts", () => {
  const fetch = vi.fn();
  const client = new TilaClient({
    baseUrl: "https://api.test",
    token: "owner",
  });
  beforeEach(() => {
    fetch.mockReset();
    fetch.mockImplementation(
      async () => new Response(JSON.stringify({ ok: true })),
    );
    vi.stubGlobal("fetch", fetch);
  });
  afterEach(() => vi.unstubAllGlobals());
  it("preserves the legacy signature and defaults principal-bound issuance to read-only", async () => {
    const tokens = createTokenMethods(client);
    await tokens.issue("old", "legacy");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      name: "old",
      note: "legacy",
    });
    await tokens.issue({ name: "new", principal_id: "service:principal" });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
      name: "new",
      principal_id: "service:principal",
      policy: CREDENTIAL_PRESETS["read-only"],
    });
  });
  it("sends the expected version and explicit overlap when rotating", async () => {
    await createTokenMethods(client).rotate("key", "current-version", 60);
    expect(fetch.mock.calls[0][0]).toBe(
      "https://api.test/api/tokens/key/rotate",
    );
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      expected_token_id: "current-version",
      overlap_seconds: 60,
    });
  });
  it("encodes stable service identities in management paths and sends binding policies", async () => {
    const services = createServiceAccountMethods(client, "project");
    await services.update("service:id", "Renamed");
    expect(fetch.mock.calls[0][0]).toBe(
      "https://api.test/projects/project/service-accounts/service%3Aid",
    );
    expect(fetch.mock.calls[0][1].method).toBe("PATCH");
    await services.updateWorkloadBinding(
      "service:id",
      "binding",
      CREDENTIAL_PRESETS["coordination-only"],
    );
    expect(fetch.mock.calls[1][0]).toContain("/workload-bindings/binding");
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
      policy: CREDENTIAL_PRESETS["coordination-only"],
    });
  });
});
