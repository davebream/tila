import {
  NAV_SECTIONS,
  PROJECT_SEGMENTS,
  defaultProjectPath,
  matchNav,
  navVisibility,
  visibleSections,
} from "@/lib/navigation";
import { CAPABILITIES, type WhoamiResponse } from "@tila/schemas";

function identity(
  policy: WhoamiResponse["policy"],
  projectId = "test-project",
): WhoamiResponse {
  return {
    ok: true,
    project_id: projectId,
    token_name: "test",
    scopes: "read",
    policy,
  };
}

const ids = (isVisible: ReturnType<typeof navVisibility>) =>
  visibleSections(isVisible).flatMap((section) =>
    section.items.map((item) => item.id),
  );

describe("matchNav", () => {
  test.each([
    ["/p/acme/tasks", "work", "tasks"],
    ["/p/acme/tasks/task-1", "work", "tasks"],
    ["/p/acme/entities/task-1", "work", "tasks"],
    ["/p/acme/queue", "work", "queue"],
    ["/p/acme/decisions/0f0e", "work", "decisions"],
    ["/p/acme/records/config/a/b", "work", "records"],
    ["/p/acme/artifacts/task/t1/report.md", "work", "artifacts"],
    ["/p/acme/journal", "work", "journal"],
    ["/p/acme/rooms/room-1", "conversations", "rooms"],
    ["/p/acme/deliveries/agent-1/d-1", "conversations", "deliveries"],
    ["/p/acme/signals", "conversations", "signals"],
    ["/p/acme/runtime/agent-1", "runtime", "runtime"],
    ["/p/acme/agents/agent-1/deliveries/d-1", "runtime", "agents"],
    ["/p/acme/presence", "runtime", "presence"],
    ["/p/acme/settings", "settings", "settings"],
    ["/p/acme/settings/definitions", "settings", "definitions"],
    ["/p/acme/settings/agents", "settings", "agent-settings"],
    ["/p/acme/settings/general", "settings", "general"],
    ["/p/acme/settings/repositories", "settings", "repositories"],
    ["/p/acme/settings/service-identities", "settings", "service-identities"],
    ["/p/acme/settings/rooms", "settings", "room-settings"],
    ["/p/acme/settings/signal-groups", "settings", "signal-group-settings"],
    ["/p/acme/overview", "overview", "overview"],
    ["tasks/task-1", "work", "tasks"],
  ])("%s belongs to %s › %s", (pathname, section, item) => {
    const match = matchNav(pathname);
    expect(match?.section.id).toBe(section);
    expect(match?.item.id).toBe(item);
  });

  test("does not match a segment by prefix", () => {
    expect(matchNav("/p/acme/tasksx")).toBeNull();
    expect(matchNav("/p/acme")).toBeNull();
  });
});

describe("navigation config", () => {
  test("every item has a unique id and segment", () => {
    const items = NAV_SECTIONS.flatMap((section) => section.items);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    expect(new Set(items.map((item) => item.segment)).size).toBe(items.length);
  });

  test("every required capability exists", () => {
    for (const section of NAV_SECTIONS)
      for (const item of section.items)
        for (const cap of item.requires) expect(CAPABILITIES).toContain(cap);
  });

  test("project segments include the entities alias", () => {
    expect(PROJECT_SEGMENTS.has("entities")).toBe(true);
    expect(PROJECT_SEGMENTS.has("rooms")).toBe(true);
    expect(PROJECT_SEGMENTS.has("p")).toBe(false);
  });

  test("the default project path is project-scoped", () => {
    expect(defaultProjectPath("acme")).toMatch(/^\/p\/acme\/[a-z]+$/);
  });
});

describe("navVisibility", () => {
  const all = NAV_SECTIONS.flatMap((section) =>
    section.items.map((item) => item.id),
  );

  test("shows everything when the identity is unknown", () => {
    expect(ids(navVisibility(undefined, "test-project"))).toEqual(all);
  });

  test("shows everything when the identity belongs to another project", () => {
    const viewer = identity(
      { role: "viewer", capabilities: ["tasks:read"] },
      "other",
    );
    expect(ids(navVisibility(viewer, "test-project"))).toEqual(all);
  });

  test("hides pages a viewer cannot read", () => {
    const viewer = identity({
      role: "viewer",
      capabilities: CAPABILITIES.filter((cap) => cap.endsWith(":read")),
    });
    const visible = ids(navVisibility(viewer, "test-project"));
    expect(visible).not.toContain("deliveries");
    expect(visible).toContain("rooms");
    expect(visible).toContain("runtime");
    expect(visible).toContain("settings");
    expect(visible).toContain("definitions");
  });

  test("a namespace-restricted credential sees only permitted surfaces", () => {
    const restricted = identity({
      role: "participant",
      capabilities: [...CAPABILITIES],
      restrictions: { task_types: ["bug"] },
    });
    const isVisible = navVisibility(restricted, "test-project");
    expect(ids(isVisible)).toEqual([
      "overview",
      "tasks",
      "queue",
      "decisions",
      "records",
      "settings",
    ]);
    expect(visibleSections(isVisible).map((section) => section.id)).toEqual([
      "overview",
      "work",
      "settings",
    ]);
  });
});

describe("session flags", () => {
  const owner: WhoamiResponse = {
    ok: true,
    project_id: "test-project",
    token_name: "owner",
    scopes: "admin",
    role: "owner",
  };
  const session = (flags: Record<string, boolean>) =>
    ({
      memberships_manage: false,
      credentials_manage: false,
      membership_available: true,
      step_up_max_age_seconds: 600,
      ...flags,
    }) as Parameters<typeof navVisibility>[2];

  test("an owner editor appears only with its own session flag", () => {
    const none = ids(navVisibility(owner, "test-project", session({})));
    expect(none).not.toContain("repositories");
    expect(none).not.toContain("service-identities");
    expect(none).toContain("general");

    const repos = ids(
      navVisibility(
        owner,
        "test-project",
        session({ repository_policy_manage: true }),
      ),
    );
    expect(repos).toContain("repositories");
    expect(repos).not.toContain("service-identities");

    const bindings = ids(
      navVisibility(
        owner,
        "test-project",
        session({ workload_bindings_manage: true }),
      ),
    );
    expect(bindings).toContain("service-identities");
  });

  test("unknown session flags keep flagged items visible rather than guessing", () => {
    expect(ids(navVisibility(owner, "test-project", null))).toContain(
      "repositories",
    );
  });
});
