import {
  type CredentialPolicy,
  type NamespaceRestrictions,
  permitsRecordRead,
} from "@tila/schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRecordCatalog, permitsRecordType } from "../src/catalog-ops";
import { checkRecordTypeDeclared } from "../src/constraint-ops";
import {
  CredentialPolicyDenied,
  assertCredentialRequest,
  assertResourceAccess,
  recordRequestTarget,
  recordRestrictionCondition,
  withholdsStoredRecordDetail,
} from "../src/credential-policy";
import { encodeCursor, fingerprint } from "../src/list-cursor";
import * as records from "../src/record-ops";
import { searchPage, searchableKinds } from "../src/search-page-ops";
import { type TestDb, createTestDb, testOrigin } from "./helpers";

const Q = [{ type: "question", key_prefixes: ["q1"] }];
const A = [{ type: "answer", key_prefixes: ["a1"] }];
const CAPS: CredentialPolicy["capabilities"] = [
  "records:read",
  "records:write",
  "claims:acquire",
];
const policy = (restrictions?: NamespaceRestrictions): CredentialPolicy => ({
  role: "participant",
  capabilities: CAPS,
  ...(restrictions === undefined ? {} : { restrictions }),
});

describe("record queries apply the read side", () => {
  let f: TestDb;
  const seed = async (type: string, key: string, text: string) => {
    await records.createRecord(
      f.db,
      {
        type,
        key,
        value: { text },
        schema_version: 1,
        actor: "test",
      },
      testOrigin("test"),
    );
  };
  beforeEach(async () => {
    f = createTestDb();
    await seed("answer", "a1/x", "needle answer");
    await seed("answer", "a2/x", "needle other answer");
    await seed("question", "q1/x", "needle question");
    await seed("question", "q2/x", "needle other question");
  });
  afterEach(() => f.rawDb.close());

  const listKeys = (type: string, restrictions?: NamespaceRestrictions) =>
    records
      .listRecords(f.db, { type, restrictions })
      .items.map((item) => `${item.type}/${item.key}`);

  it("lists only what the read side admits", () => {
    const split = { records_read: A, records_write: Q };
    expect(listKeys("answer", split)).toEqual(["answer/a1/x"]);
    expect(listKeys("question", split)).toEqual([]);
  });

  it("lists nothing for a write-only or empty-read policy", () => {
    expect(listKeys("question", { records_write: Q })).toEqual([]);
    expect(
      listKeys("question", { records_read: [], records_write: Q }),
    ).toEqual([]);
    expect(
      records.listRecords(f.db, {
        type: "question",
        restrictions: { records_write: Q },
      }).total,
    ).toBe(0);
  });

  it("keeps a legacy policy's rows on both sides", () => {
    const legacy = { records: [...Q, ...A] };
    expect(listKeys("answer", legacy)).toEqual(["answer/a1/x"]);
    expect(listKeys("question", legacy)).toEqual(["question/q1/x"]);
  });

  it("counts and enumerates types by the read side", () => {
    const split = { records_read: A, records_write: Q };
    expect(records.listRecordTypesInUse(f.db, split)).toEqual(["answer"]);
    expect(records.countRecordTypes(f.db, split)).toEqual([
      { type: "answer", count: 1, archived_count: 0 },
    ]);
    expect(records.listRecordTypesInUse(f.db, { records_write: Q })).toEqual(
      [],
    );
    expect(records.countRecordTypes(f.db, { records_write: Q })).toEqual([]);
  });

  it("searches only what the read side admits", () => {
    const found = (restrictions?: NamespaceRestrictions) =>
      records
        .searchRecords(f.db, { q: "needle", restrictions })
        .map((hit) => `${hit.record_type}/${hit.record_key}`)
        .sort();
    expect(found({ records_read: A, records_write: Q })).toEqual([
      "answer/a1/x",
    ]);
    expect(found({ records_write: Q })).toEqual([]);
    expect(found({ records: [...Q, ...A] })).toEqual([
      "answer/a1/x",
      "question/q1/x",
    ]);
    expect(found()).toHaveLength(4);
  });

  it("applies the current policy to a cursor minted under another", () => {
    const first = records.listRecords(f.db, {
      type: "answer",
      limit: 1,
    });
    expect(first.next_cursor).not.toBeNull();
    // Replaying the unrestricted cursor under a narrower read side still
    // filters every row of the page by the replaying credential's policy.
    const replay = records.listRecords(f.db, {
      type: "answer",
      limit: 1,
      cursor: first.next_cursor ?? undefined,
      restrictions: {
        records_read: [{ type: "answer", key_prefixes: ["a1"] }],
      },
    });
    expect(replay.items).toEqual([]);
    const denied = records.listRecords(f.db, {
      type: "answer",
      limit: 1,
      cursor: first.next_cursor ?? undefined,
      restrictions: { records_write: A },
    });
    expect(denied.items).toEqual([]);
    expect(denied.total).toBe(0);
  });

  it("builds each side's SQL from its own rules", () => {
    expect(recordRestrictionCondition(undefined, "read")).toBeUndefined();
    expect(recordRestrictionCondition({}, "write")).toBeUndefined();
    expect(
      recordRestrictionCondition({ records_write: Q }, "write"),
    ).toBeDefined();
    // A denied side still yields a condition (matching nothing), never none.
    expect(
      recordRestrictionCondition({ records_write: Q }, "read"),
    ).toBeDefined();
  });
});

describe("catalog and search flags", () => {
  it("lists types by the read side only", () => {
    const split = { records_read: A, records_write: Q };
    expect(permitsRecordType(split, "answer")).toBe(true);
    expect(permitsRecordType(split, "question")).toBe(false);
    expect(permitsRecordType({ records_write: Q }, "question")).toBe(false);
    expect(permitsRecordType({ records_read: [] }, "answer")).toBe(false);
    expect(permitsRecordType({ records: Q }, "question")).toBe(true);
    expect(permitsRecordType(undefined, "question")).toBe(true);
  });

  it("marks the record catalog restricted for every restriction field", () => {
    for (const restrictions of [
      { records: [] },
      { records_read: [] },
      { records_write: [] },
    ])
      expect(
        buildRecordCatalog({
          schema: { state: "none" },
          counts: [],
          restrictions,
        }).scope.restricted,
      ).toBe(true);
    expect(
      buildRecordCatalog({
        schema: { state: "none" },
        counts: [],
        restrictions: { task_types: ["t"] },
      }).scope.restricted,
    ).toBe(false);
  });

  it("marks search restricted for every restriction field", () => {
    for (const restrictions of [
      { records: [] },
      { records_read: [] },
      { records_write: [] },
      { task_types: [] },
    ])
      expect(
        searchableKinds(
          { capabilities: ["records:read", "tasks:read"], restrictions },
          undefined,
        ).restricted,
      ).toBe(true);
    expect(
      searchableKinds({ capabilities: ["records:read"], restrictions: {} }, [
        "record",
      ]).restricted,
    ).toBe(false);
  });
});

describe("record request classification", () => {
  it("reads with GET and HEAD, and writes with everything else", () => {
    for (const method of ["GET", "HEAD"])
      expect(recordRequestTarget(method, "/record/t/a/b", {})).toEqual({
        type: "t",
        key: "a/b",
        side: "read",
        echoesStored: false,
      });
    expect(recordRequestTarget("HEAD", "/record/t/a/b/history", {})).toEqual({
      type: "t",
      key: "a/b",
      side: "read",
      echoesStored: false,
    });
    for (const op of ["set", "put", "stamp-artifacts"])
      expect(recordRequestTarget("POST", `/record/t/a/b/${op}`, {})).toEqual({
        type: "t",
        key: "a/b",
        side: "write",
        echoesStored: false,
      });
    for (const op of ["patch", "archive", "unarchive"])
      expect(recordRequestTarget("POST", `/record/t/a/b/${op}`, {})).toEqual({
        type: "t",
        key: "a/b",
        side: "write",
        echoesStored: true,
      });
    expect(
      recordRequestTarget("POST", "/record/t/create", { key: "k/1" }),
    ).toEqual({ type: "t", key: "k/1", side: "write", echoesStored: false });
    for (const method of ["PUT", "PATCH", "DELETE"])
      expect(recordRequestTarget(method, "/record/t/k/x", {})?.side).toBe(
        "write",
      );
  });

  it("has no target for the routes that filter rows themselves", () => {
    expect(
      recordRequestTarget("GET", "/record/types-in-use", {}),
    ).toBeUndefined();
    expect(recordRequestTarget("GET", "/record/t/list", {})).toBeUndefined();
    expect(recordRequestTarget("GET", "/entity/list", {})).toBeUndefined();
  });

  it("withholds stored detail only from a split policy that cannot read", () => {
    const split = policy({ records_read: A, records_write: Q });
    const set = (type: string, key: string) =>
      withholdsStoredRecordDetail(
        split,
        "POST",
        `/record/${type}/${key}/set`,
        {},
      );
    expect(set("question", "q1/x")).toBe(true);
    expect(
      withholdsStoredRecordDetail(
        policy({ records: [...Q, ...A] }),
        "POST",
        "/record/question/q1/x/set",
        {},
      ),
    ).toBe(false);
    expect(
      withholdsStoredRecordDetail(
        policy(),
        "POST",
        "/record/question/q1/x/set",
        {},
      ),
    ).toBe(false);
    // Reads never withhold: they are refused or answered in full.
    expect(
      withholdsStoredRecordDetail(split, "GET", "/record/question/q1/x", {}),
    ).toBe(false);
  });
});

describe("claims on records take the side of the operation", () => {
  let f: TestDb;
  beforeEach(() => {
    f = createTestDb();
  });
  afterEach(() => f.rawDb.close());
  const split = policy({ records_read: A, records_write: Q });
  const allowed = (resource: string, side: "read" | "write") => {
    try {
      assertResourceAccess(f.db, split, resource, side);
      return true;
    } catch (error) {
      if (error instanceof CredentialPolicyDenied) return false;
      throw error;
    }
  };

  it("writes the write side and reads the read side", () => {
    expect(allowed("record:question/q1/x", "write")).toBe(true);
    expect(allowed("record:question/q1/x", "read")).toBe(false);
    expect(allowed("record:answer/a1/x", "read")).toBe(true);
    expect(allowed("record:answer/a1/x", "write")).toBe(false);
  });

  it("denies a record resource that does not name a type", () => {
    for (const side of ["read", "write"] as const) {
      expect(allowed("record:", side)).toBe(false);
      expect(allowed("record:/x", side)).toBe(false);
      expect(allowed("record:question", side)).toBe(false);
    }
  });

  it("maps claim requests by method", () => {
    const check = (method: string, resource: string) => () =>
      assertCredentialRequest(
        f.db,
        split,
        method,
        method === "GET" ? "/coord/state" : "/coord/acquire",
        new URLSearchParams(method === "GET" ? { resource } : {}),
        method === "GET" ? {} : { resource },
      );
    expect(check("POST", "record:question/q1/x")).not.toThrow();
    expect(check("GET", "record:question/q1/x")).toThrow(
      CredentialPolicyDenied,
    );
    expect(check("HEAD", "record:question/q1/x")).toThrow(
      CredentialPolicyDenied,
    );
    expect(check("GET", "record:answer/a1/x")).not.toThrow();
    expect(check("POST", "record:answer/a1/x")).toThrow(CredentialPolicyDenied);
  });
});

describe("unknown record type errors", () => {
  const schema = {
    schema_version: 1,
    records: { visible: { format: "json", history: "revision" } },
    work_units: {},
  } as unknown as Parameters<typeof checkRecordTypeDeclared>[0];
  it("lists the declared types unless asked not to", () => {
    const listed = checkRecordTypeDeclared(schema, "ghost");
    expect(listed.ok).toBe(false);
    expect(!listed.ok && listed.message).toBe(
      'Record type "ghost" is not declared in records. Declared types: visible',
    );
    const withheld = checkRecordTypeDeclared(schema, "ghost", {
      listDeclared: false,
    });
    expect(!withheld.ok && withheld.message).toBe(
      'Record type "ghost" is not declared in records.',
    );
  });
});

describe("a cursor replayed under another read side", () => {
  // Cursors carry only a position and are bound to the filter and sort they
  // were issued for. The credential's restrictions are not part of that
  // binding: they are applied to every page in SQL. These tests pin what that
  // guarantees. Visibility is always the replaying credential's own; only
  // paging (where the next page starts) can differ from a fresh listing.
  let f: TestDb;
  beforeEach(async () => {
    f = createTestDb();
    for (const key of ["a1/a", "a1/b", "a1/c", "a2/a", "a2/b"])
      await records.createRecord(
        f.db,
        {
          type: "answer",
          key,
          value: { text: "needle" },
          schema_version: 1,
          actor: "test",
        },
        testOrigin("test"),
      );
    await records.createRecord(
      f.db,
      {
        type: "question",
        key: "q1/a",
        value: { text: "needle" },
        schema_version: 1,
        actor: "test",
      },
      testOrigin("test"),
    );
  });
  afterEach(() => f.rawDb.close());

  const page = (
    restrictions: NamespaceRestrictions | undefined,
    cursor?: string | null,
    limit = 2,
  ) =>
    records.listRecords(f.db, {
      type: "answer",
      limit,
      restrictions,
      cursor: cursor ?? undefined,
    });
  const keys = (result: ReturnType<typeof page>) =>
    result.items.map((item) => item.key);

  it("returns only rows the replaying read side admits, from a wider cursor", () => {
    const minted = page(undefined);
    expect(keys(minted)).toEqual(["a1/a", "a1/b"]);

    const narrower = page(
      { records_read: [{ type: "answer", key_prefixes: ["a2"] }] },
      minted.next_cursor,
    );
    expect(keys(narrower)).toEqual(["a2/a", "a2/b"]);
    // The total is the replaying credential's own, not the minting one's.
    expect(narrower.total).toBe(2);

    const sameFirstPrefix = page(
      { records_read: [{ type: "answer", key_prefixes: ["a1"] }] },
      minted.next_cursor,
    );
    expect(keys(sameFirstPrefix)).toEqual(["a1/c"]);
    expect(sameFirstPrefix.total).toBe(3);
  });

  it("never returns a row the replaying read side excludes, even after a narrower cursor", () => {
    const narrow = {
      records_read: [{ type: "answer", key_prefixes: ["a2"] }],
    };
    const minted = page(narrow, undefined, 1);
    expect(keys(minted)).toEqual(["a2/a"]);

    // A wider credential continues from the same key. It does not see rows
    // before that key (a paging gap), and every row it does see is its own.
    const wider = page(undefined, minted.next_cursor, 10);
    expect(keys(wider)).toEqual(["a2/b"]);
    expect(wider.total).toBe(5);
  });

  it("returns nothing and no cursor to a credential that may not read", () => {
    const minted = page(undefined, undefined, 1);
    for (const restrictions of [
      { records_write: A },
      { records_read: [] as never[], records_write: A },
      { records_read: [{ type: "question" }] },
    ]) {
      const replay = page(restrictions, minted.next_cursor, 10);
      expect(replay.items).toEqual([]);
      expect(replay.total).toBe(0);
      expect(replay.next_cursor).toBeNull();
    }
  });

  it("treats a position chosen by the caller like any other", () => {
    const filter = {
      type: "answer",
      includeArchived: false,
      tag: null,
      tagFilter: null,
      dataFilter: null,
      keyContains: null,
      sort: "key",
      order: "asc",
    };
    const forged = encodeCursor(fingerprint(filter), { key: "a0" });
    expect(keys(page({ records_write: A }, forged, 10))).toEqual([]);
    expect(
      keys(
        page(
          { records_read: [{ type: "answer", key_prefixes: ["a2"] }] },
          forged,
          10,
        ),
      ),
    ).toEqual(["a2/a", "a2/b"]);
  });

  it("accepts a cursor across forms that grant the same read side", () => {
    const legacy = page({ records: A }, undefined, 2);
    const split = page(
      { records_read: A, records_write: [] },
      legacy.next_cursor,
      10,
    );
    expect(keys(legacy)).toEqual(["a1/a", "a1/b"]);
    expect(keys(split)).toEqual(["a1/c"]);
  });

  it("applies the replaying read side to a search cursor too", () => {
    const search = (
      restrictions: NamespaceRestrictions | undefined,
      cursor?: string | null,
    ) =>
      searchPage(f.db, {
        q: "needle",
        kinds: ["record"],
        limit: 2,
        restrictions,
        cursor: cursor ?? undefined,
      });
    const keyOf = (r: ReturnType<typeof search>["results"][number]) =>
      r.type === "record" ? `${r.record_type}/${r.record_key}` : "";

    const minted = search(undefined);
    expect(minted.results).toHaveLength(2);
    expect(minted.next_cursor).not.toBeNull();

    const narrow = { records_read: A, records_write: Q };
    const replayed = search(narrow, minted.next_cursor);
    for (const hit of replayed.results)
      expect(
        permitsRecordRead(
          narrow,
          hit.type === "record" ? hit.record_type : "",
          hit.type === "record" ? hit.record_key : "",
        ),
        keyOf(hit),
      ).toBe(true);

    for (const restrictions of [
      { records_write: Q },
      { records_read: [] as never[] },
    ])
      expect(search(restrictions, minted.next_cursor).results).toEqual([]);
  });
});
