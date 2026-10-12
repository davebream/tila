import {
  SummaryLine,
  TraceBadges,
  ackLabel,
  wakeLabel,
} from "@/components/delivery-trace";
import { ReplyComposer } from "@/components/reply-composer";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { QuerySection } from "@/components/ui/query-section";
import { useWhoami } from "@/hooks/use-admin";
import { useAuth } from "@/hooks/use-auth";
import {
  ApiError,
  getRoom,
  listRoomThreads,
  listRooms,
  messageDeliveries,
  roomHistory,
} from "@/lib/api";
import { draftKey, mergeMessages } from "@/lib/conversation-draft";
import { deriveSectionState } from "@/lib/query-state";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { Message } from "@tila/schemas";
import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";

export function RoomsPage() {
  const { projectId } = useAuth();
  const { roomId } = useParams();
  const rooms = useQuery({
    queryKey: ["rooms", projectId],
    queryFn: () => listRooms(projectId as string),
    enabled: !!projectId,
    refetchInterval: 10000,
  });
  // Distinct from an empty room list or a network failure: the deployment
  // lacks the conversation signing secret. Polling continues, so the page
  // recovers once an operator sets it.
  const conversationsOff =
    rooms.error instanceof ApiError &&
    rooms.error.code === "config-unavailable";
  return (
    <div className="grid gap-6 p-4 md:grid-cols-[220px_minmax(0,1fr)] md:p-6">
      <aside>
        <h1 className="mb-4 font-logo text-2xl">Rooms</h1>
        {rooms.isPending && <p>Loading rooms…</p>}
        {rooms.error && !conversationsOff && (
          <p role="alert">{rooms.error.message}</p>
        )}
        <nav aria-label="Conversation rooms" className="space-y-1">
          {rooms.data?.rooms.map((room) => (
            <Link
              key={room.id}
              to={`/p/${projectId}/rooms/${room.id}`}
              aria-current={roomId === room.id ? "page" : undefined}
              className="block rounded-md border border-border p-3 hover:bg-muted aria-[current=page]:text-signal-blue"
            >
              {room.name}
              {room.archived && " (archived)"}
            </Link>
          ))}
        </nav>
        {rooms.data?.rooms.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No accessible rooms. Create a room and enroll members through the
            CLI.
          </p>
        )}
      </aside>
      {conversationsOff ? (
        <ConversationsNotConfigured error={rooms.error} />
      ) : projectId && roomId ? (
        <RoomDetail
          key={`${projectId}:${roomId}`}
          project={projectId}
          room={roomId}
        />
      ) : (
        <p className="text-muted-foreground">
          Choose a room to read shared conversations.
        </p>
      )}
    </div>
  );
}
/**
 * The server only includes `details.reason` for callers that can manage
 * conversations, so remediation steps are shown to exactly those callers.
 */
function ConversationsNotConfigured({ error }: { error: unknown }) {
  const details =
    error instanceof ApiError ? (error.details as { reason?: unknown }) : null;
  const reason = details?.reason;
  return (
    <section
      aria-labelledby="conversations-off"
      className="rounded-lg border border-border bg-card p-4"
    >
      <h2 id="conversations-off" className="font-logo text-xl">
        Conversations are not configured
      </h2>
      {reason === "missing" || reason === "cursor-key-too-short" ? (
        <div className="mt-2 space-y-2 text-sm">
          <p>
            {reason === "missing"
              ? "This deployment has no conversation signing secret."
              : "The CONVERSATION_CURSOR_KEY secret is shorter than 32 characters."}{" "}
            Set a random key on the Worker to enable rooms and inboxes:
          </p>
          <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs">
            openssl rand -base64 32 | wrangler secret put
            CONVERSATION_CURSOR_KEY
          </pre>
          <p className="text-muted-foreground">
            This does not change token hashing, so existing tokens and sessions
            keep working. Do not set HASH_PEPPER for this.
          </p>
        </div>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          Rooms and inboxes are unavailable on this deployment. Ask a project
          maintainer to enable conversations. Tasks, records and settings are
          not affected.
        </p>
      )}
    </section>
  );
}
function RoomDetail({ project, room }: { project: string; room: string }) {
  const [params, setParams] = useSearchParams();
  const thread = params.get("thread");
  const who = useWhoami();
  const detail = useQuery({
    queryKey: ["room", project, room],
    queryFn: () => getRoom(project, room),
    refetchInterval: 10000,
  });
  const threads = useQuery({
    queryKey: ["threads", project, room],
    queryFn: () => listRoomThreads(project, room),
    refetchInterval: 10000,
  });
  const principal = who.data?.principal_id;
  const returnFocus = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const close = () => {
    setParams({});
    requestAnimationFrame(() =>
      (returnFocus.current?.isConnected
        ? returnFocus.current
        : heading.current
      )?.focus(),
    );
  };
  return (
    <section className="min-w-0 rounded-lg border border-border bg-card">
      <header className="border-b border-border p-4">
        <h2 ref={heading} tabIndex={-1} className="font-logo text-xl">
          {detail.data?.room.name ?? room}
        </h2>
        <p className="text-xs text-muted-foreground">
          Shared conversation · Peer content · Polls every 5 seconds
        </p>
      </header>
      {detail.error && (
        <p role="alert" className="p-4">
          {detail.error.message}
        </p>
      )}
      <div className="flex flex-wrap gap-2 p-4" aria-label="Threads">
        {threads.data?.threads.map((item) => (
          <Button
            key={item.id}
            variant="outline"
            size="sm"
            onClick={(event) => {
              returnFocus.current = event.currentTarget;
              setParams({ thread: item.id });
            }}
          >
            {item.title || "Untitled thread"}
          </Button>
        ))}
      </div>
      {threads.error && (
        <p role="alert" className="px-4">
          {threads.error.message}
        </p>
      )}
      <RoomStream
        project={project}
        room={room}
        thread={null}
        principal={principal}
        writable={
          detail.data?.room.archived === false && who.data?.role !== "viewer"
        }
      />
      {thread && (
        <Drawer
          title={
            threads.data?.threads.find((row) => row.id === thread)?.title ||
            "Thread"
          }
          onClose={close}
          restoreFocus={() =>
            requestAnimationFrame(() =>
              (returnFocus.current?.isConnected
                ? returnFocus.current
                : heading.current
              )?.focus(),
            )
          }
        >
          <RoomStream
            key={thread}
            project={project}
            room={room}
            thread={thread}
            principal={principal}
            writable={
              detail.data?.room.archived === false &&
              who.data?.role !== "viewer"
            }
          />
        </Drawer>
      )}
    </section>
  );
}
export function RoomStream({
  project,
  room,
  thread,
  principal,
  writable,
}: {
  project: string;
  room: string;
  thread: string | null;
  principal?: string;
  writable: boolean;
}) {
  const client = useQueryClient();
  const key = ["room-history", project, room, thread];
  const [tailCursor, setTailCursor] = useState<string | null>(null);
  const [tailRows, setTailRows] = useState<Message[]>([]);
  const [following, setFollowing] = useState(true);
  const [pausedRows, setPausedRows] = useState<Message[] | null>(null);
  const stream = useRef<HTMLOListElement>(null);
  const [announcement, setAnnouncement] = useState("");
  const [announce, setAnnounce] = useState(false);
  const history = useInfiniteQuery({
    queryKey: key,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      roomHistory(project, room, {
        thread_id: thread ?? undefined,
        direction: "backward",
        cursor: pageParam,
      }),
    getNextPageParam: (page) => (page.has_more ? page.cursor : undefined),
    maxPages: 4,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  useEffect(() => {
    if (!tailCursor && history.data?.pages[0]?.tail_cursor)
      setTailCursor(history.data.pages[0].tail_cursor);
  }, [history.data, tailCursor]);
  const tail = useQuery({
    queryKey: ["room-tail", project, room, thread, tailCursor],
    queryFn: () =>
      roomHistory(project, room, {
        thread_id: thread ?? undefined,
        cursor: tailCursor ?? undefined,
      }),
    enabled: !!tailCursor,
    gcTime: 0,
    refetchInterval: 5000,
    retry: false,
  });
  useEffect(() => {
    if (!tail.data?.messages.length) return;
    setTailRows((rows) => mergeMessages(rows, tail.data.messages).slice(-200));
    setTailCursor(tail.data.cursor);
    if (announce) setAnnouncement("New conversation messages available.");
  }, [tail.data, announce]);
  const historyRows = mergeMessages(
    ...(history.data?.pages.map((page) => page.messages) ?? []),
  );
  const visible = following
    ? mergeMessages(historyRows, tailRows).slice(-200)
    : (pausedRows ?? historyRows.slice(0, 200));
  const lastVisible = visible.at(-1)?.seq;
  useEffect(() => {
    if (following && lastVisible !== undefined && stream.current)
      stream.current.scrollTop = stream.current.scrollHeight;
  }, [following, lastVisible]);
  async function latest() {
    await client.resetQueries({ queryKey: key, exact: true });
    setTailCursor(null);
    setTailRows([]);
    setFollowing(true);
    setPausedRows(null);
  }
  const error = history.error ?? tail.error;
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 border-y border-border px-4 py-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!history.hasNextPage || history.isFetchingNextPage}
          onClick={() => {
            setPausedRows(null);
            setFollowing(false);
            void history.fetchNextPage();
          }}
        >
          Older messages
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void latest()}>
          Latest messages
        </Button>
        <label className="text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={announce}
            onChange={(event) => setAnnounce(event.target.checked)}
          />{" "}
          Announce new messages
        </label>
      </div>
      {error && (
        <p role="alert" className="p-4">
          {error instanceof ApiError && error.code === "cursor-expired"
            ? "History cursor expired. Select Latest messages to reload."
            : error.message}
        </p>
      )}
      {history.isPending && <p className="p-4">Loading conversation…</p>}
      <ol
        ref={stream}
        onScroll={(event) => {
          const element = event.currentTarget;
          if (
            following &&
            element.scrollHeight - element.clientHeight - element.scrollTop > 48
          ) {
            setPausedRows(visible);
            setFollowing(false);
          }
        }}
        aria-label={thread ? "Thread messages" : "Room messages"}
        className="max-h-[55vh] overflow-auto divide-y divide-border"
      >
        {visible.map((message) => (
          <li key={message.seq} className="p-4">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <strong className="text-foreground">
                {message.provenance.agent_id ?? message.provenance.principal_id}
              </strong>
              <span>Peer content</span>
              <time dateTime={new Date(message.created_at).toISOString()}>
                {new Date(message.created_at).toLocaleString()}
              </time>
              <span>#{message.seq}</span>
            </div>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm">
              {message.body}
            </p>
            {message.artifact_refs.length > 0 && (
              <ul className="mt-2 text-xs">
                {message.artifact_refs.map((ref) => (
                  <li key={ref}>
                    <Link
                      className="text-signal-blue underline"
                      to={`/p/${project}/artifacts/${ref.split("/").map(encodeURIComponent).join("/")}`}
                    >
                      {ref}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {!thread && message.thread_id && (
              <Link
                className="text-xs text-signal-blue underline"
                to={`?thread=${encodeURIComponent(message.thread_id)}`}
              >
                Open thread
              </Link>
            )}
            <MessageDeliveries
              project={project}
              room={room}
              message={message.id}
            />
          </li>
        ))}
      </ol>
      {!history.isPending && !error && !visible.length && (
        <p className="p-4 text-sm text-muted-foreground">No messages yet.</p>
      )}
      <p className="px-4 py-2 text-xs text-muted-foreground">
        Showing up to 200 messages.{" "}
        {!following &&
          "Reading older history; select Latest messages to see recent arrivals."}
      </p>
      <output aria-live="polite" className="sr-only">
        {announce ? announcement : ""}
      </output>
      {principal && writable && (
        <ReplyComposer
          key={draftKey(principal, project, room, thread)}
          project={project}
          room={room}
          thread={thread}
          storageKey={draftKey(principal, project, room, thread)}
          onPublished={() => {
            void client.invalidateQueries({
              queryKey: ["room-tail", project, room, thread],
            });
          }}
        />
      )}
      {!principal && (
        <p className="p-4 text-sm text-muted-foreground">
          Confirming your identity before enabling replies.
        </p>
      )}
    </>
  );
}
/**
 * Delivery outcomes for one message, loaded only when opened. Readers get
 * counts; managers also get each recipient's trace.
 */
function MessageDeliveries({
  project,
  room,
  message,
}: {
  project: string;
  room: string;
  message: string;
}) {
  const [open, setOpen] = useState(false);
  const panel = `deliveries-${message}`;
  const query = useQuery({
    queryKey: ["message-deliveries", project, room, message],
    queryFn: () => messageDeliveries(project, room, message),
    enabled: open,
    refetchInterval: open ? 10000 : false,
    retry: false,
  });
  return (
    <div className="mt-2 text-xs">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        className="text-signal-blue underline"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Hide deliveries" : "Deliveries"}
      </button>
      {open && (
        <div id={panel} className="mt-2 rounded-md border border-border p-3">
          <QuerySection
            state={deriveSectionState(query, { isEmpty: () => false })}
            label="delivery outcomes"
            empty=""
            onRetry={() => void query.refetch()}
            forbidden="You cannot read delivery outcomes for this room."
            notFound="This message is no longer available."
          >
            {(data) => (
              <div className="space-y-2">
                <p>
                  <SummaryLine summary={data.summary} />
                </p>
                {data.restricted ? (
                  <p className="text-muted-foreground">
                    Recipient, wake and binding details require conversation
                    management.
                  </p>
                ) : (
                  <ul aria-label="Recipients" className="space-y-1">
                    {data.deliveries.map(({ delivery, trace }) => (
                      <li
                        key={delivery.id}
                        className="flex flex-wrap items-center gap-2"
                      >
                        <span className="text-foreground">
                          {delivery.agent_id}
                        </span>
                        <TraceBadges trace={trace} />
                        <span>Wake: {wakeLabel(trace.wake).label}</span>
                        <span>{ackLabel(trace)[0]}</span>
                        <span>Work result: not reported</span>
                        <Link
                          className="text-signal-blue underline"
                          to={`/p/${project}/deliveries/${encodeURIComponent(delivery.agent_id)}/${encodeURIComponent(delivery.id)}`}
                        >
                          Trace
                        </Link>
                      </li>
                    ))}
                    {data.has_more && (
                      <li>
                        <Link
                          className="text-signal-blue underline"
                          to={`/p/${project}/deliveries?id=${encodeURIComponent(message)}`}
                        >
                          Browse all recipients
                        </Link>
                      </li>
                    )}
                  </ul>
                )}
              </div>
            )}
          </QuerySection>
        </div>
      )}
    </div>
  );
}
