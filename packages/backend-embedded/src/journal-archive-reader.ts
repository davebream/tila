import { type JournalArchiveReader, journalJsonLines } from "@tila/core";
import type { BlobStore } from "./blob-store";

export function createBlobJournalArchiveReader(
  blobs: BlobStore,
  projectId: string,
): JournalArchiveReader {
  return {
    async *read() {
      for (const object of await blobs.list(`journal-archive/${projectId}/`)) {
        if (!object.key.endsWith(".jsonl")) continue;
        const stream = await blobs.readStream(object.key);
        if (!stream) throw new Error(`Missing journal archive ${object.key}`);
        yield* journalJsonLines(stream);
      }
    },
  };
}
