import { type JournalArchiveReader, journalJsonLines } from "@tila/core";

export function createR2JournalArchiveReader(
  bucket: R2Bucket,
  projectId: string,
): JournalArchiveReader {
  return {
    async *read(afterSeq, throughSeq) {
      let cursor: string | undefined;
      do {
        const options = {
          prefix: `journal-archive/${projectId}/`,
          cursor,
          include: ["customMetadata"] satisfies R2ListOptions["include"],
        };
        const page = await bucket.list(options);
        for (const object of page.objects) {
          if (!object.key.endsWith(".jsonl")) continue;
          const first = Number(object.customMetadata?.first_seq);
          const last = Number(object.customMetadata?.last_seq);
          if (
            Number.isSafeInteger(first) &&
            Number.isSafeInteger(last) &&
            first > 0 &&
            last >= first &&
            (last <= afterSeq || first > throughSeq)
          )
            continue;
          const value = await bucket.get(object.key);
          if (!value) throw new Error(`Missing journal archive ${object.key}`);
          yield* journalJsonLines(value.body);
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    },
  };
}
