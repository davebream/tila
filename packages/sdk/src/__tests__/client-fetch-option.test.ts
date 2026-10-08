import { describe, expect, it, vi } from "vitest";
import { TilaClient } from "../client";

describe("TilaClient custom fetch option", () => {
  it("routes requests through the provided fetch instead of the global", async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    try {
      const custom = vi.fn(
        async (input: string | URL | Request, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input.toString();
          const headers = init?.headers as Record<string, string>;
          return new Response(
            JSON.stringify({
              ok: true,
              url,
              method: init?.method,
              participant: headers["X-Tila-Participant-Id"],
            }),
            { status: 200 },
          );
        },
      );
      const client = new TilaClient({
        baseUrl: "https://api.test",
        token: "t",
        participantId: "p-1",
        fetch: custom as unknown as typeof globalThis.fetch,
      });

      const body = await client.post<{
        url: string;
        method: string;
        participant: string;
      }>("/projects/p/claims/acquire", { resource: "r" });

      expect(custom).toHaveBeenCalledTimes(1);
      expect(globalFetch).not.toHaveBeenCalled();
      expect(body.url).toBe("https://api.test/projects/p/claims/acquire");
      expect(body.method).toBe("POST");
      expect(body.participant).toBe("p-1");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to the global fetch when no custom fetch is given", async () => {
    const globalFetch = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", globalFetch);
    try {
      const client = new TilaClient({
        baseUrl: "https://api.test",
        token: "t",
      });
      await client.get("/health");
      expect(globalFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
