import {
  type SettingsDocument,
  SettingsMappingsSchema,
  type SettingsPlan,
  type SettingsReceipt,
} from "@tila/schemas";
import { describe, expect, it, vi } from "vitest";
import { readTomlDefinition } from "../src/definition-transfer";
import { readSettingsFile, renderSettingsFile } from "../src/definition-yaml";
import {
  canonicalSettingsJson,
  createSettingsReceipt,
  executeSettingsTransfer,
  validateSettingsReceipt,
} from "../src/settings-execution";
import {
  type SettingsReadPort,
  type SettingsSnapshot,
  exportSettings,
  planSettingsImport,
  readSettingsTree,
  settingsReferences,
} from "../src/settings-transfer";
const operation = "10000000-0000-4000-8000-000000000001";
const coverage = () => ({
  status: "read" as const,
  scope: "project" as const,
  unavailable_fields: [],
});
function file(): SettingsDocument {
  return {
    tila_export: {
      format: "tila-project-settings",
      format_version: 1,
      project_id: "source",
      exported_at: "2026-10-14T00:00:00.000Z",
    },
    coverage: {
      definitions: { ...coverage(), status: "omitted" },
      agents: coverage(),
      rooms: coverage(),
      signal_groups: coverage(),
    },
    settings: {
      agents: {
        sourceagent: {
          name: "Worker",
          archived: false,
          source_revision: 9999,
          bind_policy: [
            { principal_id: "source-person", agent_id: "sourceagent" },
          ],
          profile: { state: "none" },
        },
      },
      rooms: {
        sourceroom: {
          name: "Team",
          archived: false,
          source_revision: 9999,
          history_policy: "members",
          delivery_ttl_seconds: 60,
          budgets: {
            max_hops: 2,
            pair_exchanges: 3,
            agent_wakes: 4,
            room_wakes: 5,
          },
          members: [{ member: "agent:sourceagent", wake: true }],
        },
      },
      signal_groups: {
        sourcegroup: {
          name: "Reviewers",
          source_revision: 9999,
          principal_ids: ["source-person"],
        },
      },
    },
  };
}
function sourceAgent(doc: SettingsDocument) {
  const agent = doc.settings.agents?.sourceagent;
  if (!agent) throw new Error("Missing fixture agent");
  return agent;
}
function mappings() {
  return SettingsMappingsSchema.parse({
    identities: {
      "principal:source-person": { target: "destination-person" },
      "agent:sourceagent": { target: "worker" },
    },
    profiles: {},
    resources: {
      agents: { sourceagent: { id: "worker", mode: "create" } },
      rooms: { sourceroom: { id: "team", mode: "create" } },
      signal_groups: { sourcegroup: { id: "reviewers", mode: "create" } },
    },
  });
}
function destination(): SettingsSnapshot {
  return {
    projectId: "destination",
    rights: {
      principal: "destination-person",
      creatorMember: "principal:destination-person",
      agents: true,
      agentDetails: true,
      rooms: true,
      signal_groups: true,
      definitions: true,
    },
    principals: ["destination-person"],
    agents: {},
    rooms: {},
    signal_groups: {},
    definitions: { revision: 0, source: null, doc: null, appliedAt: null },
    readable: ["agents", "rooms", "signal_groups", "definitions"],
    verifiedProfiles: [],
  };
}
function plan(): SettingsPlan {
  const result = planSettingsImport(
    file(),
    mappings(),
    destination(),
    operation,
  );
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}
describe("portable settings planner", () => {
  it("canonicalizes non-ASCII keys by Unicode code points across locale behavior", () => {
    const locale = vi
      .spyOn(String.prototype, "localeCompare")
      .mockImplementation(() => {
        throw new Error("Locale ordering must never affect receipts");
      });
    try {
      const value = { "😀": 6, é: 4, ä: 3, z: 2, a: 1, "\uE000": 5 };
      expect(canonicalSettingsJson(value)).toBe(
        '{"a":1,"z":2,"ä":3,"é":4,"\uE000":5,"😀":6}',
      );
      expect(
        canonicalSettingsJson(
          Object.fromEntries(Object.entries(value).reverse()),
        ),
      ).toBe(canonicalSettingsJson(value));
    } finally {
      locale.mockRestore();
    }
  });
  it("normalizes TOML and YAML identically and rejects settings in the definitions-only reader", () => {
    const doc = file();
    for (const format of ["toml", "yaml"] as const) {
      const text = renderSettingsFile(doc, format);
      expect(readSettingsFile(text, { format })).toEqual({
        ok: true,
        value: doc,
      });
    }
    expect(readTomlDefinition(renderSettingsFile(doc, "toml")).ok).toBe(false);
    expect(
      readTomlDefinition("schema_version = 1\n[work_units.task]\nfields = []")
        .ok,
    ).toBe(true);
  });
  it("requires every reference before optional definitions can be written", () => {
    const doc = file();
    doc.definitions = { schema_version: 1 };
    doc.coverage.definitions = coverage();
    const choices = mappings();
    choices.identities = Object.fromEntries(
      Object.entries(choices.identities).filter(
        ([key]) => key !== "principal:source-person",
      ),
    );
    expect(settingsReferences(doc)).toEqual([
      "agent:sourceagent",
      "principal:source-person",
    ]);
    expect(
      planSettingsImport(doc, choices, destination(), operation),
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ code: "unmapped-reference" }),
      ]),
    });
  });
  it("rejects unknown targets, unreadable sections, collisions, and archived revival", () => {
    const unknown = destination();
    unknown.principals = [];
    expect(planSettingsImport(file(), mappings(), unknown, operation).ok).toBe(
      false,
    );
    const denied = destination();
    denied.readable = [];
    expect(planSettingsImport(file(), mappings(), denied, operation).ok).toBe(
      false,
    );
    const archived = file();
    sourceAgent(archived).archived = true;
    expect(
      planSettingsImport(archived, mappings(), destination(), operation),
    ).toMatchObject({ ok: false });
  });
  it("drops individual grants/members/recipients without deleting resources", () => {
    const choices = mappings();
    choices.identities["principal:source-person"] = { drop: true };
    const result = planSettingsImport(
      file(),
      choices,
      destination(),
      operation,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.actions[0].payload).toMatchObject({ bind_policy: [] });
    expect(result.value.actions.at(-1)?.payload).toMatchObject({
      principal_ids: [],
    });
    expect(result.value.actions.every((a) => !a.kind.includes("delete"))).toBe(
      true,
    );
  });
  it("requires explicit profile remapping, accepts a selected offline profile with pending warning, and ignores no verification flag", () => {
    const doc = file();
    sourceAgent(doc).profile = {
      state: "selected",
      selection: {
        profile_id: "source-profile",
        host_ref: "source-host",
        account_ref: "source-account",
      },
    };
    expect(
      planSettingsImport(doc, mappings(), destination(), operation),
    ).toMatchObject({ ok: false });
    const choices = mappings();
    choices.profiles.sourceagent = {
      selection: {
        profile_id: "destination-profile",
        host_ref: "destination-host",
        account_ref: "destination-account",
      },
    };
    const result = planSettingsImport(doc, choices, destination(), operation);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.actions[1].payload).toEqual({
      profile_selection: choices.profiles.sourceagent.selection,
    });
    expect(result.value.warnings.join(" ")).toContain("pending/unverified");
    expect(JSON.stringify(result.value.actions)).not.toContain("source-host");
    expect(
      SettingsMappingsSchema.safeParse({
        ...choices,
        profiles: {
          sourceagent: { ...choices.profiles.sourceagent, verified: true },
        },
      }).success,
    ).toBe(false);
  });
  it("excludes secrets and nonconfigured fields, validates coverage, and retains hidden policies", () => {
    for (const field of [
      "credentials",
      "bindings",
      "binding_epoch",
      "lease",
      "messages",
      "memberships",
      "owner_principal_id",
    ]) {
      const doc = file();
      Object.assign(sourceAgent(doc), { [field]: "redacted" });
      expect(readSettingsTree(doc).ok).toBe(false);
    }
    const hidden = file();
    hidden.settings.agents = {
      sourceagent: { name: "Worker", archived: false, source_revision: 1 },
    };

    hidden.coverage.agents.unavailable_fields = [
      "sourceagent.bind_policy",
      "sourceagent.profile",
    ];
    expect(readSettingsTree(hidden).ok).toBe(true);
    expect(
      planSettingsImport(hidden, mappings(), destination(), operation).ok,
    ).toBe(false); // never invent a create policy
    const failed = file();
    failed.coverage.agents.status = "failed";
    expect(readSettingsTree(failed).ok).toBe(false);
    const secret = file();
    sourceAgent(secret).name = `sk-${"s".repeat(30)}`;
    expect(readSettingsTree(secret).ok).toBe(false);
  });
  it("shows automatic creator membership removal last and chains each member revision", () => {
    const p = plan();
    const room = p.actions.filter((a) => a.kind.startsWith("room."));
    expect(room.map((a) => a.kind)).toEqual([
      "room.create",
      "room.member",
      "room.member",
    ]);
    expect(room[1].revision_from).toBe(room[0].id);
    expect(room[2].revision_from).toBe(room[1].id);
    expect(room[2].payload).toEqual({
      member: "principal:destination-person",
      wake: null,
    });
    expect(p.removals).toContain(
      "room:team member principal:destination-person",
    );
    expect(p.actions.at(-1)?.expected_revision).toBe(0); // source revision is never authority
  });
});
describe("frozen receipts and resume", () => {
  it("persists uncertain state before calls, stops on partial failure and resumes only unresolved actions", async () => {
    const p = plan();
    let saved: SettingsReceipt | undefined;
    const writes = vi
      .fn()
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(
        Object.assign(new Error("denied"), {
          status: 403,
          code: "permission-denied",
        }),
      );
    const port = {
      projectId: "destination",
      preflight: vi.fn(),
      write: writes,
    };
    const receipt = await createSettingsReceipt(p);
    const persist = (r: SettingsReceipt) => {
      saved = structuredClone(r);
    };
    const partial = await executeSettingsTransfer(port, receipt, persist, {
      confirmRemovals: true,
    });
    expect(partial.actions.map((a) => a.status)).toEqual([
      "committed",
      "failed",
      "not-attempted",
      "not-attempted",
      "not-attempted",
    ]);
    writes.mockImplementation(async (action, expected) => {
      expect(
        saved?.actions.find((a) => a.action_id === action.id)?.status,
      ).toBe("uncertain");
      if (action.revision_from) expect(expected).toBeGreaterThan(0);
      return writes.mock.calls.length + 1;
    });
    const resumed = await executeSettingsTransfer(
      port,
      JSON.parse(JSON.stringify(saved)),
      persist,
      { confirmRemovals: true },
    );
    expect(resumed.actions.every((a) => a.status === "committed")).toBe(true);
    expect(
      writes.mock.calls.filter(([a]) => a.id === p.actions[0].id),
    ).toHaveLength(1);
  });
  it("a permission change before resume gives zero writes and retains committed receipts", async () => {
    const receipt = await createSettingsReceipt(plan());
    receipt.actions[0] = {
      action_id: receipt.actions[0].action_id,
      status: "committed",
      revision: 2,
    };
    const write = vi.fn();
    const persist = vi.fn();
    await expect(
      executeSettingsTransfer(
        {
          projectId: "destination",
          preflight: async () => {
            throw new Error("denied");
          },
          write,
        },
        receipt,
        persist,
        { confirmRemovals: true },
      ),
    ).rejects.toThrow("denied");
    expect(write).not.toHaveBeenCalled();
    expect(persist.mock.calls[0][0].actions[0].status).toBe("committed");
  });
  it("retains stable payloads/revisions after lost response and never refreshes a conflict", async () => {
    const receipt = await createSettingsReceipt(plan());
    const write = vi
      .fn()
      .mockResolvedValueOnce(7)
      .mockRejectedValueOnce(new Error("lost response"));
    const partial = await executeSettingsTransfer(
      { projectId: "destination", preflight: vi.fn(), write },
      receipt,
      vi.fn(),
      { confirmRemovals: true },
    );
    expect(partial.actions[1].status).toBe("uncertain");
    write.mockRejectedValueOnce(
      Object.assign(new Error("race"), {
        status: 412,
        code: "revision-conflict",
      }),
    );
    const again = await executeSettingsTransfer(
      { projectId: "destination", preflight: vi.fn(), write },
      partial,
      vi.fn(),
      { confirmRemovals: true },
    );
    expect(again.actions[0].revision).toBe(7);
    expect(again.actions[1].status).toBe("failed");
    expect(write.mock.calls[1]).toEqual(write.mock.calls[2]);
  });
  it("refuses changed plan, target, revision chain, unconfirmed removals and failed persistence before writes", async () => {
    const receipt = await createSettingsReceipt(plan());
    const port = {
      projectId: "destination",
      preflight: vi.fn(),
      write: vi.fn(),
    };
    await expect(
      executeSettingsTransfer(port, receipt, vi.fn()),
    ).rejects.toMatchObject({ code: "removals-not-confirmed" });
    const changed = structuredClone(receipt);
    changed.plan.project_id = "other";
    await expect(
      validateSettingsReceipt(changed, "destination"),
    ).rejects.toMatchObject({ code: "project-mismatch" });
    const tampered = structuredClone(receipt);
    tampered.plan.actions[0].resource_id = "other";
    await expect(
      validateSettingsReceipt(tampered, "destination"),
    ).rejects.toThrow();
    await expect(
      executeSettingsTransfer(
        port,
        receipt,
        async () => {
          throw new Error("disk full");
        },
        { confirmRemovals: true },
      ),
    ).rejects.toThrow("disk full");
    expect(port.write).not.toHaveBeenCalled();
  });
});
describe("coverage-aware export", () => {
  function port(): SettingsReadPort {
    return {
      identity: async () => ({
        ok: true,
        project_id: "source",
        scopes: "read",
        token_name: "test",
        principal_id: "person",
        role: "viewer",
        policy: {
          role: "viewer",
          capabilities: ["agents:read"],
          restrictions: {},
        },
      }),
      principals: async () => [],
      agents: async () => [
        {
          id: "worker",
          name: "Worker",
          owner_principal_id: "secret-owner",
          bind_policy: [],
          profile_selection: null,
          binding_epoch: 99,
          archived: false,
          revision: 2,
          created_at: 1,
          updated_at: 1,
        },
      ],
      rooms: async () => [],
      room: async () => {
        throw new Error("unused");
      },
      groups: async () => [],
      definitions: async () => ({
        revision: 0,
        source: null,
        doc: null,
        appliedAt: null,
      }),
    };
  }
  it("marks redacted grants/profile unavailable instead of exporting empty replacements", async () => {
    const doc = await exportSettings(port(), "source", {
      sections: ["agents"],
    });
    expect(doc.settings.agents?.worker).toEqual({
      name: "Worker",
      source_revision: 2,
      archived: false,
    });
    expect(doc.coverage.agents.unavailable_fields).toEqual([
      "worker.bind_policy",
      "worker.profile",
    ]);
    expect(JSON.stringify(doc)).not.toContain("secret-owner");
    expect(JSON.stringify(doc)).not.toContain("binding_epoch");
  });
  it("denied selected sections are visibly unavailable; failed reads never produce a complete export", async () => {
    const p = port();
    p.groups = async () => {
      throw Object.assign(new Error("denied"), { status: 403 });
    };
    expect(
      (await exportSettings(p, "source", { sections: ["signal_groups"] }))
        .coverage.signal_groups.status,
    ).toBe("unavailable");
    p.groups = async () => {
      throw new Error("offline");
    };
    await expect(
      exportSettings(p, "source", { sections: ["signal_groups"] }),
    ).rejects.toMatchObject({ code: "export-incomplete" });
  });
});

const credentialShapes = [
  `tila_d1_${"a".repeat(72)}`,
  `tila_u_${"a".repeat(20)}`,
  `ghp_${"a".repeat(32)}`,
  `github_pat_${"a".repeat(32)}`,
  ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
  `AKIA${"A".repeat(16)}`,
  `ASIA${"B".repeat(16)}`,
  `xoxb-${"a".repeat(20)}`,
  `sk-${"a".repeat(25)}`,
  `sk-ant-${"a".repeat(25)}`,
  `eyJ${"a".repeat(12)}.eyJ${"b".repeat(12)}.${"c".repeat(12)}`,
];
it.each(
  credentialShapes.flatMap((secret, index) =>
    ["host_ref", "account_ref"].map((field) => ({ secret, index, field })),
  ),
)(
  "blocks credential pattern $index in mapping-only $field before any artifact/persistence/service call",
  async ({ secret, field }) => {
    const doc = file();
    sourceAgent(doc).profile = {
      state: "selected",
      selection: { profile_id: "source-profile" },
    };
    const choices = mappings();
    choices.profiles.sourceagent = {
      selection: {
        profile_id: "destination-profile",
        host_ref: null,
        account_ref: null,
        [field]: secret,
      },
    };
    expect(SettingsMappingsSchema.safeParse(choices).success).toBe(false);
    const rejected = planSettingsImport(doc, choices, destination(), operation);
    expect(rejected.ok).toBe(false);
    expect(JSON.stringify(rejected)).not.toContain(secret);
    const raw = await createSettingsReceipt(plan());
    raw.plan.mappings = choices;
    const persist = vi.fn();
    const preflight = vi.fn(async () => {
      throw new Error("Access denied");
    });
    const write = vi.fn();
    await expect(
      executeSettingsTransfer(
        { projectId: "destination", preflight, write },
        raw,
        persist,
        { confirmRemovals: true },
      ),
    ).rejects.toThrow();
    expect(persist).not.toHaveBeenCalled();
    expect(preflight).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    await expect(
      createSettingsReceipt({ ...plan(), mappings: choices }),
    ).rejects.toThrow();
  },
);
it("validates mapped agents with read access without requiring unrelated agent management", async () => {
  const { inspectSettingsDestination } = await import(
    "../src/settings-transfer"
  );
  const p: SettingsReadPort = {
    identity: async () => ({
      ok: true,
      project_id: "destination",
      scopes: "scoped",
      token_name: "fixture",
      principal_id: "destination-person",
      role: "maintainer",
      policy: {
        role: "maintainer",
        capabilities: [
          "conversations:read",
          "conversations:manage",
          "agents:read",
        ],
      },
    }),
    principals: vi.fn(),
    agents: async () => [
      {
        id: "worker",
        name: "Worker",
        archived: false,
        revision: 2,
        owner_principal_id: "owner",
        bind_policy: [],
        profile_selection: null,
        binding_epoch: 0,
        created_at: 1,
        updated_at: 1,
      },
    ],
    rooms: async () => [],
    room: vi.fn(),
    groups: vi.fn(),
    definitions: vi.fn(),
  };
  const choices = SettingsMappingsSchema.parse({
    identities: { "agent:sourceagent": { target: "worker" } },
    resources: { rooms: { sourceroom: { id: "team", mode: "create" } } },
  });
  const snapshot = await inspectSettingsDestination(
    p,
    "destination",
    ["rooms"],
    choices,
  );
  expect(snapshot.rights.agents).toBe(false);
  expect(snapshot.agents.worker.id).toBe("worker");
  expect(p.principals).not.toHaveBeenCalled();
  expect(p.groups).not.toHaveBeenCalled();
});
