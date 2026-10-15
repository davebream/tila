import { rights } from "@/lib/rights";
import {
  type CredentialPolicy,
  type NamespaceRestrictions,
  type RecordAccessSide,
  type WhoamiResponse,
  permitsRecordSide,
} from "@tila/schemas";

const PROJECT = "test-project";

function identity(
  restrictions: NamespaceRestrictions | undefined,
  options: {
    role?: "viewer" | "participant" | "maintainer" | "owner";
    capabilities?: CredentialPolicy["capabilities"];
    policy?: boolean;
  } = {},
): WhoamiResponse {
  const role = options.role ?? "participant";
  return {
    ok: true,
    project_id: PROJECT,
    token_name: "test",
    scopes: role === "viewer" ? "read" : "write",
    role,
    principal_id: "principal-1",
    ...(options.policy === false
      ? {}
      : {
          policy: {
            role,
            capabilities: options.capabilities ?? [
              "records:read",
              "records:write",
            ],
            ...(restrictions === undefined ? {} : { restrictions }),
          },
        }),
  } as WhoamiResponse;
}

const read = (restrictions?: NamespaceRestrictions) =>
  rights(identity(restrictions), PROJECT).readRecord;
const write = (restrictions?: NamespaceRestrictions) =>
  rights(identity(restrictions), PROJECT).writeRecord;

/** answer/a1 may be read; question/q1 may be written; nothing else. */
const SPLIT: NamespaceRestrictions = {
  records_read: [{ type: "answer", key_prefixes: ["a1"] }],
  records_write: [{ type: "question", key_prefixes: ["q1"] }],
};

describe("record rights follow the side of the action", () => {
  describe("a credential that reads answer/a1 and writes question/q1", () => {
    it("offers the write to the write-only key, and no read of it", () => {
      expect(write(SPLIT)("question", "q1")).toBe(true);
      expect(write(SPLIT)("question", "q1/deep")).toBe(true);
      expect(read(SPLIT)("question", "q1")).toBe(false);
    });

    it("offers the read to the read-only key, and no write to it", () => {
      expect(read(SPLIT)("answer", "a1")).toBe(true);
      expect(read(SPLIT)("answer", "a1/x")).toBe(true);
      expect(write(SPLIT)("answer", "a1")).toBe(false);
    });

    it("refuses a sibling key that only shares a spelling", () => {
      expect(write(SPLIT)("question", "q10")).toBe(false);
      expect(read(SPLIT)("answer", "a10")).toBe(false);
    });

    it("means some permitted key when no key is given", () => {
      expect(write(SPLIT)("question")).toBe(true);
      expect(read(SPLIT)("question")).toBe(false);
      expect(read(SPLIT)("answer")).toBe(true);
      expect(write(SPLIT)("answer")).toBe(false);
      expect(write(SPLIT)("unrelated")).toBe(false);
      expect(read(SPLIT)("unrelated")).toBe(false);
    });
  });

  it("offers neither side a write for a read-only split credential, whatever the type", () => {
    const readOnly: NamespaceRestrictions = {
      records_read: [{ type: "answer" }],
    };
    // The old check let any type through when `records` was absent.
    expect(write(readOnly)("answer")).toBe(false);
    expect(write(readOnly)("anything")).toBe(false);
    expect(write(readOnly)("answer", "k")).toBe(false);
    expect(read(readOnly)("answer")).toBe(true);
    expect(read(readOnly)("answer", "k")).toBe(true);
  });

  it("offers no read for a write-only split credential, whatever the type", () => {
    const writeOnly: NamespaceRestrictions = {
      records_write: [{ type: "question" }],
    };
    expect(read(writeOnly)("question")).toBe(false);
    expect(read(writeOnly)("question", "k")).toBe(false);
    expect(write(writeOnly)("question")).toBe(true);
    expect(write(writeOnly)("question", "k")).toBe(true);
    expect(write(writeOnly)("other")).toBe(false);
  });

  it("keeps a legacy list meaning both sides", () => {
    const legacy: NamespaceRestrictions = {
      records: [{ type: "config", key_prefixes: ["team"] }],
    };
    for (const check of [read(legacy), write(legacy)]) {
      expect(check("config")).toBe(true);
      expect(check("config", "team/a")).toBe(true);
      expect(check("config", "other")).toBe(false);
      expect(check("flag")).toBe(false);
    }
  });

  it("does not offer a type whose rule admits no keys", () => {
    const legacy: NamespaceRestrictions = {
      records: [{ type: "config", key_prefixes: [] }],
    };
    expect(write(legacy)("config")).toBe(false);
    expect(read(legacy)("config")).toBe(false);
    const split: NamespaceRestrictions = {
      records_read: [{ type: "answer", key_prefixes: [] }],
      records_write: [],
    };
    expect(read(split)("answer")).toBe(false);
    expect(write(split)("answer")).toBe(false);
  });

  it("offers everything an unrestricted credential holds", () => {
    expect(read()("any", "key")).toBe(true);
    expect(write()("any", "key")).toBe(true);
    expect(read()("any")).toBe(true);
    expect(write()("any")).toBe(true);
  });

  it("needs the capability of the side as well as the rule", () => {
    const unrestricted = (caps: CredentialPolicy["capabilities"]) =>
      rights(identity(undefined, { capabilities: caps }), PROJECT);
    expect(unrestricted(["records:read"]).writeRecord("t")).toBe(false);
    expect(unrestricted(["records:write"]).readRecord("t")).toBe(false);
    expect(unrestricted(["records:write"]).writeRecord("t")).toBe(true);
    expect(unrestricted(["records:read"]).readRecord("t")).toBe(true);
  });

  it("never offers a write to a viewer, and still offers the read", () => {
    const viewer = rights(identity(undefined, { role: "viewer" }), PROJECT);
    expect(viewer.writeRecord("t")).toBe(false);
    expect(viewer.writeRecord("t", "k")).toBe(false);
    expect(viewer.readRecord("t", "k")).toBe(true);
  });

  it("keeps a credential without a policy on its role's compatibility", () => {
    const plain = rights(identity(undefined, { policy: false }), PROJECT);
    expect(plain.writeRecord("t", "k")).toBe(true);
    expect(plain.readRecord("t", "k")).toBe(true);
  });

  it("agrees with the server's per-key predicate for every side and key", () => {
    // The UI only decides what to offer; it must never offer what the shared
    // side predicate refuses, or hide what it allows.
    const cases: NamespaceRestrictions[] = [
      SPLIT,
      { records: [{ type: "config", key_prefixes: ["a", "b/c"] }] },
      { records_write: [{ type: "question" }] },
      { records_read: [], records_write: [{ type: "q", key_prefixes: ["k"] }] },
    ];
    const types = ["answer", "question", "config", "q", "other"];
    const keys = ["a1", "a1/x", "q1", "q1/x", "a", "b/c", "b/c/d", "k", "zzz"];
    const sides: RecordAccessSide[] = ["read", "write"];
    for (const restrictions of cases)
      for (const side of sides)
        for (const type of types)
          for (const key of keys) {
            const ui = (side === "read" ? read : write)(restrictions)(
              type,
              key,
            );
            expect(ui, `${side} ${type}/${key}`).toBe(
              permitsRecordSide(restrictions, side, type, key),
            );
          }
  });
});
