import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { ReentryResponseSchema } from "@tila/schemas";
import type {
  EnvironmentMetadata,
  LifecycleClient,
  LifecycleEvent,
  LifecycleState,
  ReentryResponse,
} from "@tila/schemas";
import type { TilaFacade } from "tila-sdk";
import { type ProcessIdentity, type SessionStore, sessionKey } from "./store";

export type LifecycleFacade = Pick<
  TilaFacade,
  "reentry" | "presence" | "journal" | "handoffs" | "claims"
>;
export type FacadeFactory = (state: LifecycleState) => Promise<LifecycleFacade>;
export function environmentMetadata(
  client: LifecycleClient,
  cwd: string,
): EnvironmentMetadata {
  const command = (bin: string, args: string[]) => {
    try {
      return (
        execFileSync(bin, args, {
          cwd,
          encoding: "utf8",
          timeout: 1000,
          stdio: ["ignore", "pipe", "ignore"],
        })
          .trim()
          .slice(0, 2048) || undefined
      );
    } catch {
      return undefined;
    }
  };
  // Never send userinfo embedded in a remote URL.
  const remote = command("git", ["config", "--get", "remote.origin.url"]);
  let repository = remote;
  if (remote?.startsWith("https://") || remote?.startsWith("http://")) {
    const url = new URL(remote);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    repository = url.toString();
  }
  return {
    machine: hostname(),
    repository,
    worktree: command("git", ["rev-parse", "--show-toplevel"]) ?? cwd,
    branch: command("git", ["branch", "--show-current"]),
    commit: command("git", ["rev-parse", "HEAD"]),
    client_name: client,
    client_version: command(client === "codex" ? "codex" : "claude", [
      "--version",
    ]),
  };
}

/** A bounded context page. Only fully included, contiguous events may be acknowledged. */
export function reentryContext(
  response: ReentryResponse,
  cursor: number,
  participantId: string,
): { text: string; seq: number } {
  const events = [...response.changes.events];
  const make = () => ({
    participant_id: participantId,
    summary: response.summary,
    changes: events,
    has_more:
      response.changes.has_more ||
      events.length < response.changes.events.length,
    active_claims: response.active_claims,
    pending_signals: response.pending_signals,
    handoff: response.handoff,
  });
  let text = JSON.stringify(make());
  while (text.length > 8000 && events.length) {
    events.pop();
    text = JSON.stringify(make());
  }
  if (text.length > 8000)
    return {
      text: JSON.stringify({
        participant_id: participantId,
        degraded:
          "Re-entry context exceeds hook budget. Use the configured MCP re-entry operation to recover context; cursor was not advanced.",
      }),
      seq: cursor,
    };
  const seq =
    events.at(-1)?.seq ??
    (response.changes.events.length === 0
      ? response.changes.next_after_seq
      : cursor);
  return { text, seq };
}

export class Lifecycle {
  constructor(
    readonly store: SessionStore,
    readonly namespace: string,
    readonly facade: FacadeFactory,
  ) {}
  async start(
    client: LifecycleClient,
    event: LifecycleEvent,
    owner: ProcessIdentity | null,
    environment: EnvironmentMetadata,
  ): Promise<{ state: LifecycleState; text: string }> {
    const key = sessionKey(this.namespace, client, event.session_id);
    return this.store.locked(key, async () => {
      const old = this.store.read(key);
      if (old?.phase === "closing")
        throw new Error(
          "Previous shutdown is incomplete; run tila lifecycle status before resuming",
        );
      const resumed = old && old.phase !== "active";
      const state: LifecycleState =
        old && !resumed
          ? old
          : {
              version: 1,
              key,
              namespace: this.namespace,
              client,
              sessionId: event.session_id,
              participantId: old?.participantId ?? `tila-${key}`,
              cwd: event.cwd,
              environment,
              generation: randomUUID(),
              owner,
              worker: null,
              phase: "active",
              observedSeq: old?.observedSeq ?? 0,
              offeredSeq: old?.observedSeq ?? 0,
              lastHeartbeat: null,
              degraded: null,
              reentryPending: true,
              pendingHandoff: null,
              handoffSaved: false,
              cursorSaved: false,
              releaseClaims: [],
            };
      state.owner = owner;
      state.cwd = event.cwd;
      state.environment = environment;
      state.reentryPending = true;
      this.store.write(state);
      try {
        const api = await this.facade(state);
        const { cursor } = await api.journal.getCursor();
        state.observedSeq = Math.max(state.observedSeq, cursor.seq);
        const response = await api.reentry({
          after_seq: state.observedSeq,
          limit: 20,
        });
        const context = reentryContext(
          ReentryResponseSchema.parse(response),
          state.observedSeq,
          state.participantId,
        );
        // The next supported hook confirms that execution continued after context delivery.
        state.offeredSeq = context.seq;
        state.reentryPending = false;
        state.degraded = null;
        this.store.write(state);
        return { state, text: context.text };
      } catch {
        state.degraded =
          "Tila re-entry unavailable; coordination is degraded. Retry on the next prompt or run tila lifecycle status.";
        this.store.write(state);
        return {
          state,
          text: JSON.stringify({
            participant_id: state.participantId,
            degraded: state.degraded,
          }),
        };
      }
    });
  }
  async observe(key: string): Promise<void> {
    await this.store.locked(key, async () => {
      const state = this.store.read(key);
      if (!state || state.phase !== "active") return;
      state.observedSeq = Math.max(state.observedSeq, state.offeredSeq);
      this.store.write(state);
    });
  }
  async end(key: string): Promise<void> {
    await this.store.locked(key, async () => {
      const state = this.store.read(key);
      if (!state || (state.phase !== "active" && state.phase !== "crashed"))
        return;
      state.phase = "closing";
      // Persist immutable intent BEFORE sending. The exact UUID/body survives ambiguous delivery.
      state.pendingHandoff = {
        id: randomUUID(),
        kind: "shutdown",
        summary: `${state.client} session ended; coordination snapshot only.`,
        current_state: {
          environment: state.environment,
          session_id: state.sessionId,
          cleanup: "requested",
        },
        based_on_seq: state.observedSeq,
        findings: [],
        unresolved_questions: [],
        references: [],
      };
      this.store.write(state);
    });
  }
  async tick(
    key: string,
    generation: string,
    alive: boolean,
  ): Promise<boolean> {
    return this.store.locked(key, async () => {
      const state = this.store.read(key);
      if (
        !state ||
        state.generation !== generation ||
        state.phase === "closed" ||
        state.phase === "crashed"
      )
        return false;
      if (state.phase === "active" && !alive) {
        state.phase = "crashed";
        state.degraded =
          "Client runtime is no longer available. No cleanup was attempted; claims expire normally.";
        this.store.write(state);
        return false;
      }
      try {
        const api = await this.facade(state);
        if (state.phase === "active") {
          await api.presence.heartbeat({
            lifecycle: "active",
            session_id: state.sessionId,
          });
          state.lastHeartbeat = Date.now();
        } else {
          if (!state.pendingHandoff) throw new Error("Missing shutdown intent");
          if (!state.handoffSaved) {
            const { handoff } = await api.handoffs.create(state.pendingHandoff);
            state.releaseClaims = handoff.active_claims
              .filter(
                (claim) =>
                  claim.participant_id === state.participantId &&
                  claim.mode !== "owner",
              )
              .map(({ resource, fence }) => ({ resource, fence }));
            state.handoffSaved = true;
            state.degraded = null;
            this.store.write(state);
            return true;
          }
          if (!state.cursorSaved) {
            await api.journal.acknowledge({ seq: state.observedSeq });
            state.cursorSaved = true;
            this.store.write(state);
            return true;
          }
          if (state.releaseClaims.length) {
            const claim = state.releaseClaims[0];
            // Never replace a stored fence with a newer holder's fence.
            const current = (await api.claims.get(claim.resource)).claim;
            if (
              current?.participant_id === state.participantId &&
              current.fence === claim.fence &&
              current.mode !== "owner"
            )
              await api.claims.release(claim.resource, claim.fence);
            state.releaseClaims.shift();
            this.store.write(state);
          }
          if (state.releaseClaims.length === 0) state.phase = "closed";
        }
        state.degraded =
          state.phase === "active" && state.reentryPending
            ? "Tila re-entry is pending; retry on the next prompt. Presence alone does not restore context."
            : null;
      } catch {
        state.degraded =
          state.phase === "closing"
            ? "Shutdown incomplete. Handoff/cursor/claim cleanup will retry; no success is assumed."
            : "Tila heartbeat unavailable; coordination is degraded.";
      }
      this.store.write(state);
      return state.phase !== "closed";
    });
  }
}
