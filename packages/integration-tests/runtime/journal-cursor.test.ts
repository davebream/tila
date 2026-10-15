import { runInDurableObject } from "cloudflare:test";
import { createJournalMethods } from "tila-sdk";
import { expect, it } from "vitest";
import { queueApiFixture } from "./queue-api-fixture";
import { bindings } from "./setup";

interface JournalPage {
  ok: boolean;
  events: { seq: number; kind: string }[];
  archived: boolean;
  lastArchivedSeq: number | null;
}

/** Append `count` rows with the columns `appendJournal` writes. */
async function seedBurst(project: string, count: number) {
  const stub = bindings.PROJECT.get(bindings.PROJECT.idFromName(project));
  await runInDurableObject(stub, (_instance, state) => {
    for (let index = 0; index < count; index++) {
      state.storage.sql.exec(
        "INSERT INTO journal (t, kind, resource, principal_id, participant_id, environment, actor, data) VALUES (?, 'entity.updated', ?, 'seed', 'seed', '{}', '', '{}')",
        Date.now(),
        `burst-${index}`,
      );
    }
  });
  return stub;
}

function range(from: number, through: number): number[] {
  return Array.from({ length: through - from + 1 }, (_, i) => from + i);
}

it("pages a journal burst larger than two pages in order through the Worker and SDK", async () => {
  const { project, http, client } = await queueApiFixture();
  const stub = await seedBurst(project, 250);
  const stored = (
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec("SELECT seq FROM journal ORDER BY seq").toArray(),
    )
  ).map((row) => Number(row.seq));
  expect(stored).toEqual(range(1, 251)); // The applied schema holds seq 1.

  // Raw HTTP: follow after_seq one page at a time, as the dashboard tail does.
  const httpPages: number[][] = [];
  let cursor = 0;
  for (let guard = 0; guard < 10; guard++) {
    const response = await http(`/journal?after_seq=${cursor}&limit=100`);
    expect(response.status, await response.clone().text()).toBe(200);
    const page = (await response.json()) as JournalPage;
    expect(page.archived).toBe(false);
    const seqs = page.events.map((event) => event.seq);
    httpPages.push(seqs);
    if (seqs.length > 0) cursor = seqs[seqs.length - 1];
    if (seqs.length < 100) break;
  }
  expect(httpPages.map((page) => page.length)).toEqual([100, 100, 51]);
  expect(httpPages.flat()).toEqual(stored);

  // SDK: the same route, resumed from a mid-journal cursor.
  const journal = createJournalMethods(client, project);
  const sdkPage = await journal.query({ after_seq: "240", limit: "3" });
  expect(sdkPage.events.map((event) => event.seq)).toEqual([241, 242, 243]);

  // A read with no cursor is still the newest page, newest first.
  const recent = (await (await http("/journal?limit=3")).json()) as JournalPage;
  expect(recent.events.map((event) => event.seq)).toEqual([251, 250, 249]);
});

it("keeps the archive watermark boundary exact for cursor reads", async () => {
  const { project, http } = await queueApiFixture();
  const stub = await seedBurst(project, 20); // seq 1..21
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec("DELETE FROM journal WHERE seq <= 10");
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO _journal_archive_watermark (id, last_archived_seq, archived_at) VALUES (1, 10, ?)",
      Date.now(),
    );
  });

  // Below the watermark: no live rows, and the caller is told why.
  const below = (await (
    await http("/journal?after_seq=9&limit=5")
  ).json()) as JournalPage;
  expect(below).toMatchObject({
    events: [],
    archived: true,
    lastArchivedSeq: 10,
  });

  // Exactly at the watermark: the first live page, oldest first, not archived.
  const at = (await (
    await http("/journal?after_seq=10&limit=5")
  ).json()) as JournalPage;
  expect(at.archived).toBe(false);
  expect(at.lastArchivedSeq).toBe(10);
  expect(at.events.map((event) => event.seq)).toEqual(range(11, 15));

  // Resuming from the last seq of that page continues without a gap.
  const next = (await (
    await http("/journal?after_seq=15&limit=100")
  ).json()) as JournalPage;
  expect(next.events.map((event) => event.seq)).toEqual(range(16, 21));
});
