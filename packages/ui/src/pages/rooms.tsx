import { ReplyComposer } from "@/components/reply-composer";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { useWhoami } from "@/hooks/use-admin";
import { useAuth } from "@/hooks/use-auth";
import {
  ApiError,
  getRoom,
  listRoomThreads,
  listRooms,
  roomHistory,
} from "@/lib/api";
import { draftKey, mergeMessages } from "@/lib/conversation-draft";
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
  return (
    <div className="grid gap-6 p-4 md:grid-cols-[220px_minmax(0,1fr)] md:p-6">
      <aside>
        <h1 className="mb-4 font-logo text-2xl">Rooms</h1>
        {rooms.isPending && <p>Loading rooms…</p>}
        {rooms.error && <p role="alert">{rooms.error.message}</p>}
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
      {projectId && roomId ? (
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
