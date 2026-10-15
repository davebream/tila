import { runInDurableObject } from "cloudflare:test";
import { JOURNAL_REPLAY_SCAN_BUDGET } from "@tila/schemas";
import { expect, it } from "vitest";
import { archiveJournal } from "../../worker/src/lib/admin-ops";
import type { Env } from "../../worker/src/types";
import { queueApiFixture } from "./queue-api-fixture";
import { bindings } from "./setup";

const DAY_MS = 86_400_000;
type Page = {
  ok: true;
  events: { seq: number; kind: string; data: Record<string, unknown> }[];
  next_after_seq: number;
  through_seq: number;
  has_more: boolean;
};
const report = (event_name: string, correlation_id: string) => ({
  event_name,
  event_version: 1,
  target: { kind: "project" as const },
  data: {},
  correlation_id,
});

async function setup() {
  const fixture = await queueApiFixture();
  const stub = bindings.PROJECT.get(
    bindings.PROJECT.idFromName(fixture.project),
  );
  const append = async (event_name: string, correlation_id: string) => {
    const response = await fixture.http(
      "/journal",
      report(event_name, correlation_id),
      "worker",
      `${event_name}:${correlation_id}`,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { event: { seq: number } }).event.seq;
  };
  const sql = <T = Record<string, unknown>>(
    statement: string,
    ...values: (string | number)[]
  ) =>
    runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql.exec(statement, ...values).toArray() as T[],
    );
  /** Age every row so far past the 90-day boundary, then archive it for real. */
  const archiveEverything = async () => {
    await sql("UPDATE journal SET t = ?", Date.now() - 100 * DAY_MS);
    const result = await archiveJournal(
      { ARTIFACTS: bindings.ARTIFACTS } as unknown as Env,
      stub,
      fixture.project,
    );
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    return result.body as { archived: number };
  };
  const replay = async (query: string): Promise<Page> => {
    const response = await fixture.http(`/journal/replay?${query}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Page;
  };
  return { ...fixture, stub, append, sql, archiveEverything, replay };
}

it("finds a report older than the archive boundary by name and by correlation in a mixed project", async () => {
  const t = await setup();
  const oldPassed = await t.append("pipeline.tests_passed", "run-old");
  const oldOther = await t.append("pipeline.deployed", "run-other");
  expect((await t.archiveEverything()).archived).toBeGreaterThan(0);
  const watermark = await t.sql<{ last_archived_seq: number }>(
    "SELECT last_archived_seq FROM _journal_archive_watermark",
  );
  expect(watermark[0].last_archived_seq).toBeGreaterThanOrEqual(oldOther);
  expect(await t.sql("SELECT seq FROM journal")).toEqual([]);

  const livePassed = await t.append("pipeline.tests_passed", "run-live");
  const liveVerified = await t.append("pipeline.verified", "run-old");

  const seqs = async (query: string) =>
    (await t.replay(`after_seq=0&${query}`)).events.map((e) => e.seq);
  expect(await seqs("event_name=pipeline.tests_passed")).toEqual([
    oldPassed,
    livePassed,
  ]);
  expect(await seqs("correlation_id=run-old")).toEqual([
    oldPassed,
    liveVerified,
  ]);
  expect(
    await seqs("event_name=pipeline.verified&correlation_id=run-old"),
  ).toEqual([liveVerified]);
  expect(
    await seqs("event_name=pipeline.deployed&correlation_id=run-live"),
  ).toEqual([]);
  expect(await seqs("event_name=pipeline.deployed")).toEqual([oldOther]);

  const page = await t.replay("after_seq=0&correlation_id=run-old");
  expect(page).toMatchObject({
    through_seq: liveVerified,
    next_after_seq: liveVerified,
    has_more: false,
  });
  expect(page.events[0]).toMatchObject({
    kind: "custom.reported",
    data: { event_name: "pipeline.tests_passed", correlation_id: "run-old" },
  });
  // Unfiltered replay of the same project is still complete.
  const everything = await t.replay("after_seq=0&limit=200");
  expect(everything.events.map((e) => e.seq)).toContain(oldPassed);
  expect(everything.events.length).toBe(liveVerified);
});

it("fails closed over HTTP when archived history is lost, even for a filter that matches nothing", async () => {
  const t = await setup();
  await t.append("pipeline.tests_passed", "run-old");
  await t.archiveEverything();
  const objects = await bindings.ARTIFACTS.list({
    prefix: `journal-archive/${t.project}/`,
  });
  expect(objects.objects.length).toBeGreaterThan(0);
  for (const object of objects.objects)
    await bindings.ARTIFACTS.delete(object.key);

  for (const query of [
    "event_name=no.such_event",
    "correlation_id=no-such-run",
    "event_name=pipeline.tests_passed",
  ]) {
    const response = await t.http(`/journal/replay?after_seq=0&${query}`);
    expect(response.status, query).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "journal-history-unavailable", retryable: true },
    });
  }
  // The same window unfiltered is equally unavailable, never silently empty.
  expect((await t.http("/journal/replay?after_seq=0")).status).toBe(503);
});

it("pages the whole history through a bounded scan with honest progress", async () => {
  const t = await setup();
  const [{ top }] = await t.sql<{ top: number }>(
    "SELECT max(seq) AS top FROM journal",
  );
  const oldRows = 1400;
  const liveRows = 750;
  const needleOld = top + 1200;
  const needleLive = top + oldRows + 700;
  const insert = (count: number, from: number, t0: number) =>
    runInDurableObject(t.stub, (_instance, state) => {
      for (let index = 1; index <= count; index++) {
        const seq = from + index;
        const needle = seq === needleOld || seq === needleLive;
        state.storage.sql.exec(
          "INSERT INTO journal (seq, t, kind, resource, principal_id, participant_id, environment, actor, data) VALUES (?, ?, ?, 'project', 'principal', 'participant', '{}', '', ?)",
          seq,
          t0,
          needle ? "custom.reported" : "entity.created",
          JSON.stringify(
            needle ? report("needle.found", "needle") : { index: seq },
          ),
        );
      }
    });
  await insert(oldRows, top, Date.now() - 100 * DAY_MS);
  await t.archiveEverything();
  await insert(liveRows, top + oldRows, Date.now());
  const total = top + oldRows + liveRows;

  const pages: Page[] = [];
  let after = 0;
  let through: number | undefined;
  for (let guard = 0; guard < 10; guard++) {
    const page = await t.replay(
      `after_seq=${after}&limit=5&event_name=needle.found${
        through === undefined ? "" : `&through_seq=${through}`
      }`,
    );
    pages.push(page);
    expect(page.next_after_seq).toBeGreaterThan(after);
    through = page.through_seq;
    after = page.next_after_seq;
    if (!page.has_more) break;
  }
  expect(through).toBe(total);
  expect(pages.map((page) => page.events.map((e) => e.seq))).toEqual([
    [],
    [needleOld],
    [needleLive],
  ]);
  expect(pages.map((page) => page.next_after_seq)).toEqual([
    JOURNAL_REPLAY_SCAN_BUDGET,
    JOURNAL_REPLAY_SCAN_BUDGET * 2,
    total,
  ]);
  expect(pages.map((page) => page.has_more)).toEqual([true, true, false]);

  // Resuming mid-range, as a client would after a restart, repeats nothing.
  const resumed = await t.replay(
    `after_seq=${needleOld}&limit=5&event_name=needle.found&through_seq=${total}`,
  );
  expect(resumed.events.map((e) => e.seq)).toEqual([needleLive]);
});
