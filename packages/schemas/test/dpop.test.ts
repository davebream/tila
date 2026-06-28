import { describe, expect, it } from "vitest";
import { DPOP_ALG, DPOP_TYP, canonicalizeHtu } from "../src/dpop";

describe("canonicalizeHtu", () => {
  it("keeps https with non-default port", () => {
    expect(canonicalizeHtu("https://example.com:8443/api/tasks")).toBe(
      "https://example.com:8443/api/tasks",
    );
  });

  it("drops default port 443 for https", () => {
    expect(canonicalizeHtu("https://example.com:443/api/tasks")).toBe(
      "https://example.com/api/tasks",
    );
  });

  it("drops default port 80 for http", () => {
    expect(canonicalizeHtu("http://example.com:80/api/tasks")).toBe(
      "http://example.com/api/tasks",
    );
  });

  it("keeps non-default port 8080 for http", () => {
    expect(canonicalizeHtu("http://localhost:8080/api/tasks")).toBe(
      "http://localhost:8080/api/tasks",
    );
  });

  it("strips query string", () => {
    expect(
      canonicalizeHtu("https://example.com/api/tasks?foo=bar&baz=qux"),
    ).toBe("https://example.com/api/tasks");
  });

  it("strips fragment", () => {
    expect(canonicalizeHtu("https://example.com/api/tasks#section")).toBe(
      "https://example.com/api/tasks",
    );
  });

  it("strips both query and fragment", () => {
    expect(canonicalizeHtu("https://example.com/api/tasks?x=1#frag")).toBe(
      "https://example.com/api/tasks",
    );
  });

  it("lowercases the host", () => {
    expect(canonicalizeHtu("https://EXAMPLE.COM/api/tasks")).toBe(
      "https://example.com/api/tasks",
    );
  });

  it("lowercases scheme", () => {
    expect(canonicalizeHtu("HTTPS://example.com/api/tasks")).toBe(
      "https://example.com/api/tasks",
    );
  });

  it("preserves exact path — no trailing-slash normalization", () => {
    expect(canonicalizeHtu("https://example.com/api/tasks/")).toBe(
      "https://example.com/api/tasks/",
    );
  });

  it("root path with no trailing slash", () => {
    expect(canonicalizeHtu("https://example.com/")).toBe(
      "https://example.com/",
    );
  });

  it("custom domain (not *.workers.dev)", () => {
    expect(
      canonicalizeHtu("https://tila.mycompany.com/api/tasks?foo=bar"),
    ).toBe("https://tila.mycompany.com/api/tasks");
  });

  it("*.workers.dev host", () => {
    expect(
      canonicalizeHtu("https://my-worker.workers.dev/api/tasks?query=1"),
    ).toBe("https://my-worker.workers.dev/api/tasks");
  });

  it("mixed-case *.workers.dev host is lowercased", () => {
    expect(canonicalizeHtu("https://My-Worker.Workers.Dev/api/tasks")).toBe(
      "https://my-worker.workers.dev/api/tasks",
    );
  });
});

describe("DPoP header constants", () => {
  it("DPOP_TYP is dpop+jwt", () => {
    expect(DPOP_TYP).toBe("dpop+jwt");
  });

  it("DPOP_ALG is ES256", () => {
    expect(DPOP_ALG).toBe("ES256");
  });
});
