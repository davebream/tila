import { describe, expect, it, vi } from "vitest";
import {
  createMembershipMethods,
  createProjectMethods,
  createRepoMethods,
} from "../access";
import { TilaClient } from "../client";

function setup() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const client = new TilaClient({
    baseUrl: "https://example.test",
    token: "fixture",
    participantId: "participant",
    fetch,
  });
  const call = (index: number) => {
    const [url, init] = fetch.mock.calls[index];
    return {
      url: String(url),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
  };
  return { fetch, client, call };
}

const policy = {
  min_read_permission: "read",
  min_write_permission: "write",
  max_permission: "write",
  membership_enabled: false,
  membership_role_cap: "participant",
} as const;

describe("access administration methods", () => {
  it("writes repository policy against a revision on a chosen host", async () => {
    const { fetch, client, call } = setup();
    const repos = createRepoMethods(client);
    fetch.mockResolvedValueOnce(
      Response.json({ ok: true, github_repo_id: 7, policy, revision: 3 }),
    );
    const result = await repos.setAccessPolicy(7, policy, {
      expectedRevision: 2,
      host: "github.example.com",
    });
    expect(result.revision).toBe(3);
    expect(call(0)).toMatchObject({
      method: "PUT",
      url: "https://example.test/api/repos/7/access-policy?host=github.example.com",
      body: { ...policy, expected_revision: 2 },
    });
    fetch.mockResolvedValueOnce(
      Response.json({ ok: true, github_repo_id: 7, removed_at: 1 }),
    );
    await repos.remove(7, { expectedRevision: 3 });
    expect(call(1).url).toBe(
      "https://example.test/api/repos/7?expected_revision=3",
    );
  });

  it("renames the project against the reviewed revision", async () => {
    const { fetch, client, call } = setup();
    const project = createProjectMethods(client, "p");
    const settings = {
      project_id: "p",
      display_name: "Payments",
      created_at: 1,
      created_by: "owner",
      revision: 2,
    };
    fetch.mockResolvedValueOnce(Response.json({ ok: true, settings }));
    await project.rename("Payments", 1);
    expect(call(0)).toMatchObject({
      method: "PATCH",
      url: "https://example.test/projects/p/project-settings",
      body: { display_name: "Payments", expected_revision: 1 },
    });
  });

  it("revokes memberships by ID", async () => {
    const { fetch, client, call } = setup();
    const members = createMembershipMethods(client, "p");
    fetch.mockResolvedValueOnce(
      Response.json(
        {
          ok: false,
          error: {
            code: "last-owner",
            message: "Cannot revoke the last owner",
          },
        },
        { status: 409 },
      ),
    );
    await expect(members.revoke("m-1")).rejects.toMatchObject({
      status: 409,
      message: "Cannot revoke the last owner",
    });
    expect(call(0)).toMatchObject({
      method: "DELETE",
      url: "https://example.test/projects/p/memberships/m-1",
    });
  });
});
