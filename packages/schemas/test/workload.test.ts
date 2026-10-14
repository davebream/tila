import { describe, expect, it } from "vitest";
import {
  GITHUB_ACTIONS_ISSUER,
  GitHubActionsContextSchema,
  GitHubActionsHostSchema,
  GitHubActionsTrustedIssuersSchema,
  githubActionsIdentity,
} from "../src/workload";

const entry = {
  issuer: "https://github--enterprise.example/_services/token",
  host: "github--enterprise.example",
  jwks_uri: "https://github--enterprise.example/_services/token/keys",
};
const context = { repository_id: 42, sub: "repo:org/repo", event_name: "push" };

describe("Actions deployment trust and workload identities", () => {
  it("accepts explicit HTTPS endpoints and valid DNS labels", () => {
    expect(GitHubActionsTrustedIssuersSchema.parse([entry])).toEqual([entry]);
  });
  it.each([
    "https://ghe.example",
    "ghe.example:443",
    "owner@ghe.example",
    "-ghe.example",
    "ghe-.example",
    "ghe..example",
    "ghe.example/path",
    "ghe.example.",
    "GHE.example",
    `${"a".repeat(64)}.example`,
    "",
  ])("rejects ambiguous repository host %s", (host) => {
    expect(GitHubActionsHostSchema.safeParse(host).success).toBe(false);
  });
  it.each([
    { issuer: "invalid-url" },
    { issuer: "https://ghe.example/token?" },
    { jwks_uri: "https://ghe.example/keys#" },
    { issuer: "http://ghe.example/token" },
    { jwks_uri: "http://ghe.example/keys" },
    { issuer: "https://user:password@ghe.example/token" },
    { jwks_uri: "https://ghe.example/keys?secret=hidden" },
    { issuer: "https://ghe.example/token#fragment" },
    { issuer: GITHUB_ACTIONS_ISSUER },
    { host: "github.com" },
    { discovery: "https://ghe.example/discovery" },
  ])("rejects invalid or built-in overrides %j", (overrides) => {
    expect(
      GitHubActionsTrustedIssuersSchema.safeParse([{ ...entry, ...overrides }])
        .success,
    ).toBe(false);
  });
  it("rejects duplicate exact and canonical issuer identities", () => {
    for (const duplicate of [
      entry,
      { ...entry, host: "other.example" },
      { ...entry, issuer: `${entry.issuer}/` },
    ]) {
      expect(
        GitHubActionsTrustedIssuersSchema.safeParse([entry, duplicate]).success,
      ).toBe(false);
    }
  });
  it("maps missing legacy fields only to GitHub.com and rejects partial identity", () => {
    expect(
      githubActionsIdentity(GitHubActionsContextSchema.parse(context)),
    ).toEqual({
      issuer: GITHUB_ACTIONS_ISSUER,
      host: "github.com",
    });
    expect(
      GitHubActionsContextSchema.safeParse({ ...context, issuer: entry.issuer })
        .success,
    ).toBe(false);
    expect(
      GitHubActionsContextSchema.safeParse({
        ...context,
        repository_host: entry.host,
      }).success,
    ).toBe(false);
    expect(
      githubActionsIdentity(
        GitHubActionsContextSchema.parse({
          ...context,
          issuer: entry.issuer,
          repository_host: entry.host,
        }),
      ),
    ).toEqual({ issuer: entry.issuer, host: entry.host });
  });
});
