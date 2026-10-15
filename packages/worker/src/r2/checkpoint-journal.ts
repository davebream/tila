/** Remove journal segments from the discarded history while recovery holds maintenance. */
export async function reconcileCheckpointJournal(
  bucket: R2Bucket,
  projectId: string,
  keep: string[],
): Promise<void> {
  const prefix = `journal-archive/${projectId}/`;
  if (keep.some((key) => !key.startsWith(prefix)))
    throw new Error("Journal archive belongs to another project");
  const retained = new Set(keep);
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    const obsolete = page.objects
      .filter((object) => !retained.has(object.key))
      .map((object) => object.key);
    if (obsolete.length) await bucket.delete(obsolete);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
