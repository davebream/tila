import {
  type Message,
  type PublishMessage,
  PublishMessageSchema,
} from "@tila/schemas";

export interface ReplyDraft {
  revision: string;
  body: string;
  pending: { revision: string; message: PublishMessage } | null;
}
export const emptyDraft = (): ReplyDraft => ({
  revision: crypto.randomUUID(),
  body: "",
  pending: null,
});
export function editDraft(draft: ReplyDraft, body: string): ReplyDraft {
  return { ...draft, revision: crypto.randomUUID(), body };
}
export function stageReply(
  draft: ReplyDraft,
  thread: string | null,
): ReplyDraft {
  if (draft.pending) return draft;
  return {
    ...draft,
    pending: {
      revision: draft.revision,
      message: {
        client_op_id: crypto.randomUUID(),
        body: draft.body,
        thread_id: thread,
        artifact_refs: [],
        targets: [{ kind: "room" }],
        reply_expected: false,
      },
    },
  };
}
export function completeReply(
  draft: ReplyDraft,
  operation: string,
): ReplyDraft {
  if (draft.pending?.message.client_op_id !== operation) return draft;
  return draft.revision === draft.pending.revision
    ? emptyDraft()
    : { ...draft, pending: null };
}
export function draftKey(
  principal: string,
  project: string,
  room: string,
  thread: string | null,
): string {
  return `tila.reply.1:${JSON.stringify([principal, project, room, thread])}`;
}
export function saveDraft(key: string, draft: ReplyDraft): boolean {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}
export function loadDraft(key: string): ReplyDraft {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (raw) {
      const value = JSON.parse(raw) as ReplyDraft;
      if (
        typeof value.body === "string" &&
        typeof value.revision === "string" &&
        (value.pending === null ||
          (typeof value.pending?.revision === "string" &&
            PublishMessageSchema.safeParse(value.pending.message).success))
      )
        return value;
    }
  } catch {
    /* Unavailable or corrupt browser storage. */
  }
  return emptyDraft();
}
/** Server sequence is stable across overlapping history and tail responses. */
export function mergeMessages(...pages: readonly Message[][]): Message[] {
  const rows = new Map<number, Message>();
  for (const page of pages)
    for (const message of page) rows.set(message.seq, message);
  return [...rows.values()].sort((a, b) => a.seq - b.seq);
}
