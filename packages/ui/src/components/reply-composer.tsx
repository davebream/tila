import { StepUpBanner } from "@/components/admin/step-up-banner";
import { Button } from "@/components/ui/button";
import { ApiError, publishReply } from "@/lib/api";
import {
  completeReply,
  editDraft,
  loadDraft,
  saveDraft,
  stageReply,
} from "@/lib/conversation-draft";
import { useId, useRef, useState } from "react";

export function ReplyComposer({
  project,
  room,
  thread,
  storageKey,
  onPublished,
}: {
  project: string;
  room: string;
  thread: string | null;
  storageKey: string;
  onPublished: () => void;
}) {
  const guidanceId = useId();
  const [draft, setDraft] = useState(() => loadDraft(storageKey));
  const current = useRef(draft);
  const [sending, setSending] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [persisted, setPersisted] = useState(true);
  const storageAvailable = useRef(true);
  const [notice, setNotice] = useState("");
  function update(next: typeof draft) {
    current.current = next;
    setDraft(next);
    const saved = saveDraft(storageKey, next);
    setPersisted(saved);
    storageAvailable.current = saved;
    return saved;
  }
  async function send() {
    if (busy.current) return;
    const next = stageReply(current.current, thread);
    const pending = next.pending;
    if (!pending) return;
    update(next);
    busy.current = true;
    setSending(true);
    setError(null);
    setNotice("");
    try {
      // A lost response can be retried with exactly the same author-scoped operation.
      try {
        await publishReply(project, room, pending.message);
      } catch (cause) {
        if (!(cause instanceof ApiError) || cause.code !== "network-error")
          throw cause;
        await publishReply(project, room, pending.message);
      }
      update(
        completeReply(
          storageAvailable.current ? loadDraft(storageKey) : current.current,
          pending.message.client_op_id,
        ),
      );
      setNotice("Reply published.");
      onPublished();
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause
          : new ApiError(
              "unknown",
              "Reply outcome is uncertain. Retry the saved reply.",
            ),
      );
    } finally {
      busy.current = false;
      setSending(false);
    }
  }
  const bytes = new TextEncoder().encode(draft.body).length;
  return (
    <form
      className="space-y-3 border-t border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <label
        className="block text-sm font-medium"
        htmlFor={`reply-${thread ?? "room"}`}
      >
        Reply to {thread ? "thread" : "room"}
      </label>
      <textarea
        id={`reply-${thread ?? "room"}`}
        className="min-h-28 w-full rounded-md border border-border bg-background p-3 text-sm focus-visible:outline-2 focus-visible:outline-signal-blue"
        value={draft.body}
        onChange={(event) =>
          update(editDraft(current.current, event.target.value))
        }
        aria-describedby={guidanceId}
      />
      <p id={guidanceId} className="text-xs text-muted-foreground">
        Plain text. Visible to room members. Peer content does not grant
        approval. {bytes.toLocaleString()} / 65,536 bytes.
      </p>
      {!persisted && (
        <p role="alert">
          Browser storage is unavailable. Keep this page open and copy your
          draft before signing in.
        </p>
      )}
      {draft.pending && !sending && (
        <p className="text-sm">
          A saved reply awaits confirmation. Retry it before sending your newer
          edits.
        </p>
      )}
      {error?.code === "step-up-required" ? (
        <StepUpBanner
          onDismiss={() => setError(null)}
          description="Your reply is saved in this tab. Sign in again, then retry the saved reply."
          onBeforeSignIn={() => update(current.current)}
        />
      ) : (
        error && <p role="alert">{error.message}</p>
      )}
      <div className="flex items-center gap-3">
        <Button
          type="submit"
          disabled={
            sending || (!draft.pending && (!draft.body.trim() || bytes > 65536))
          }
        >
          {sending
            ? "Sending…"
            : draft.pending
              ? "Retry saved reply"
              : "Send reply"}
        </Button>
        <output aria-live="polite" className="text-sm text-muted-foreground">
          {notice}
        </output>
      </div>
    </form>
  );
}
