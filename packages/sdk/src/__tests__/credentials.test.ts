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
  it("passes caller revisions through and propagates conflicts without retry", async () => {
    const services = createServiceAccountMethods(client, "project");
    await services.update("service:id", "Reviewed", 7);
    await services.updateWorkloadBinding(
      "service:id",
      "binding",
      CREDENTIAL_PRESETS.worker,
      9,
    );
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      display_name: "Reviewed",
      expected_revision: 7,
    });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
      policy: CREDENTIAL_PRESETS.worker,
      expected_revision: 9,
    });
    fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: "revision-conflict",
            message: "Reload",
            revision: 10,
            resource: "workload-binding",
          },
        }),
        { status: 412 },
      ),
    );
    await expect(
      services.updateWorkloadBinding(
        "service:id",
        "binding",
        CREDENTIAL_PRESETS.worker,
        9,
      ),
    ).rejects.toMatchObject({
      code: "revision-conflict",
      status: 412,
      extras: { revision: 10, resource: "workload-binding" },
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    await services.revoke("service:id");
    await services.revokeWorkloadBinding("service:id", "binding");
    expect(fetch.mock.calls.slice(3).map((call) => call[1].body)).toEqual([
      undefined,
      undefined,
    ]);
  });
});
