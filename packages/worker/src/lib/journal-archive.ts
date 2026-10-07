/** Both manual and scheduled archives use the same immutable object layout. */
export function journalArchiveObjects<T extends { seq: number; t: number }>(
  projectId: string,
  events: T[],
  throughSeq: number,
) {
  const groups = new Map<string, T[]>();
  for (const event of events) {
    const date = new Date(event.t);
    const month = `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    const group = groups.get(month) ?? [];
    group.push(event);
    groups.set(month, group);
  }
  return [...groups].map(([month, rows]) => ({
    key: `journal-archive/${projectId}/${month}.part-${throughSeq}-from-${rows[0].seq}.jsonl`,
    body: rows.map((row) => JSON.stringify(row)).join("\n"),
    customMetadata: {
      first_seq: String(rows[0].seq),
      last_seq: String(rows[rows.length - 1].seq),
    },
  }));
}
