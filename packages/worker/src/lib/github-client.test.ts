import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUserByLogin } from "./github-client";

// Stub global fetch so tests don't make real HTTP calls.
// githubFetch in github-fetch.ts calls `fetch(url, init)` — mock it here.
const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  mockFetch.mockReset();
});

describe("getUserByLogin", () => {
  it("resolves { login, id } on a 200 response", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ login: "octocat", id: 1296269, name: "The Octocat" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await getUserByLogin("ghs_token123", "octocat");

    expect(result).toEqual({ login: "octocat", id: 1296269 });
    // Verify the correct URL was called
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe("https://api.github.com/users/octocat");
  });

  it("returns null on a 404 response", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await getUserByLogin("ghs_token123", "no-such-user-xyz");

    expect(result).toBeNull();
  });

  it("throws on a non-2xx non-404 response (e.g. 500)", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Internal Server Error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(getUserByLogin("ghs_token123", "octocat")).rejects.toThrow();
  });

  it("respects the optional apiBase parameter", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ login: "ghes-user", id: 999 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await getUserByLogin(
      "ghs_token123",
      "ghes-user",
      "https://github.example.com/api/v3",
    );

    expect(result).toEqual({ login: "ghes-user", id: 999 });
    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe("https://github.example.com/api/v3/users/ghes-user");
  });

  it("includes Authorization Bearer header in the request", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ login: "octocat", id: 1296269 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await getUserByLogin("ghs_secret_token", "octocat");

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe("Bearer ghs_secret_token");
  });
});
