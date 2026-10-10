import { randomUUID } from "node:crypto";
import type { RuntimeRunContext } from "@tila/schemas";
import type { TilaFacade } from "tila-sdk";
import type { ControlRequest } from "./control";
import type { DiscoveredSession, SessionDiscovery } from "./discovery";
import type { ConnectorStore, Ledger, Registration } from "./store";

export interface RelayHandle {
  api: Pick<TilaFacade, "agents" | "dispatch">;
  context: RuntimeRunContext;
  close(): Promise<void>;
}
export interface RelayFactory {
  start(session: DiscoveredSession, operationId: string): Promise<RelayHandle>;
  /** Close only this registration's old relay, including an uncertain creation. */
  recover(registration: Registration): Promise<void>;
}
export class HostConnector {
  readonly ledger: Ledger;
  private relays = new Map<string, RelayHandle>();
  private queue: Promise<unknown> = Promise.resolve();
  private stopping = false;
  constructor(
    readonly store: ConnectorStore,
    readonly discovery: SessionDiscovery,
    readonly factory: RelayFactory,
  ) {
    this.ledger = store.read();
  }
  private persist(): void {
    this.store.write(this.ledger);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }
  status() {
    return {
      hostRef: this.ledger.hostRef,
      heartbeat: this.ledger.heartbeat,
      stopping: this.stopping,
      registrations: this.ledger.registrations.map(
        ({
          key,
          agent,
          profile,
          state,
          reason,
          bindingId,
          bindingEpoch,
          pending,
        }) => ({
          key,
          agent,
          profile,
          state,
          reason,
          bindingId,
          bindingEpoch,
          pendingWake: pending
            ? {
                outcome: pending.outcome ?? "unknown",
                reported: pending.reported,
              }
            : null,
        }),
      ),
    };
  }
  request(request: ControlRequest): Promise<unknown> {
    if (request.action === "status") return Promise.resolve(this.status());
    if (request.action === "stop") {
      this.stopping = true;
      return Promise.resolve({ stopping: true });
    }
    return this.serial(async () => {
      if (this.stopping) throw new Error("Connector is stopping");
      if (request.action === "unregister") {
        const entry = this.ledger.registrations.find(
          (r) => r.key === request.key,
        );
        if (entry) await this.remove(entry);
        return this.status();
      }
      const existing = this.ledger.registrations.find(
        (r) => r.key === request.key,
      );
      const session = await this.discovery.discover(request.key, existing);
      if (existing) {
        if (
          existing.allowIdleStart !== request.allowIdleStart ||
          existing.expectedEpoch !== request.expectedEpoch
        )
          throw new Error(
            "Registration policy differs; unregister explicitly first",
          );
        return this.status();
      }
      if (this.ledger.registrations.length >= 32)
        throw new Error("Connector registration limit reached");
      if (
        this.ledger.registrations.some(
          (r) =>
            r.namespace === session.state.namespace &&
            r.agent === session.context.agent_id,
        )
      )
        throw new Error(
          "Agent already registered on this connector; unregister the old occupant first",
        );
      const entry: Registration = {
        key: request.key,
        generation: session.state.generation,
        owner: session.state.owner,
        agent: session.context.agent_id as string,
        profile: session.state.profile,
        namespace: session.state.namespace,
        actingRunId: session.context.run_id,
        expectedEpoch: request.expectedEpoch,
        allowIdleStart: request.allowIdleStart,
        relayOperationId: randomUUID(),
        state: "registering",
      };
      this.ledger.registrations.push(entry);
      this.persist(); // Intent precedes relay creation and attachment.
      await this.attach(entry, session);
      return this.status();
    });
  }
  private async attach(
    entry: Registration,
    session: DiscoveredSession,
  ): Promise<RelayHandle> {
    let relay = this.relays.get(entry.key);
    if (!relay) {
      relay = await this.factory.start(session, entry.relayOperationId);
      if (
        relay.context.run_role !== "relay" ||
        relay.context.agent_id !== entry.agent ||
        relay.context.enrollment_id !== session.context.enrollment_id ||
        relay.context.project_id !== session.context.project_id ||
        relay.context.instance_id !== session.context.instance_id
      ) {
        await relay.close();
        throw new Error("Relay credential scope mismatch");
      }
      this.relays.set(entry.key, relay);
      entry.relayRunId = relay.context.run_id;
      this.persist();
    }
    const { binding } = await relay.api.agents.bind(entry.agent, {
      expected_epoch: entry.expectedEpoch,
      acting_run_id: entry.actingRunId,
      harness: session.state.client,
      native_session_ref: {
        host_ref: this.ledger.hostRef,
        harness: session.state.client,
        profile_id: entry.profile.id,
        session_id: session.state.sessionId,
      },
      profile: session.evidence,
      capability_report: session.capabilities,
      mechanism: session.mechanism,
      attended: true,
      allow_idle_start: entry.allowIdleStart,
    });
    entry.bindingId = binding.consumer_binding_id;
    entry.bindingEpoch = binding.binding_epoch;
    entry.state = "active";
    entry.reason = undefined;
    this.persist();
    return relay;
  }
  /** Recovery never repeats a native wake; it rechecks the exact leased recipient snapshot. */
  private async reconcile(
    entry: Registration,
    relay: RelayHandle,
  ): Promise<boolean> {
    const pending = entry.pending;
    if (!pending) return false;
    const status = await relay.api.dispatch.status(
      entry.agent,
      pending.leaseToken,
    );
    if (
      status.binding.consumer_binding_id !== pending.bindingId ||
      status.binding.binding_epoch !== pending.bindingEpoch
    )
      throw new Error("Binding changed during wake recovery");
    if (!status.attempt || status.server_now === undefined) {
      entry.reason =
        "Server lacks dispatch reconciliation metadata; upgrade the server";
      this.persist();
      return true;
    }
    if (status.attempt.outcome !== "leased") {
      pending.outcome = status.attempt.outcome;
      pending.reported = true;
      this.persist();
    }
    const attemptCreatedAt = status.attempt.created_at;
    const fetched =
      status.deliveries.length > 0 &&
      status.deliveries.every(
        (d) =>
          d.state !== "pending" ||
          (d.fetched_at !== null &&
            d.fetched_at >= attemptCreatedAt &&
            d.fetched_binding_id === pending.bindingId &&
            d.fetched_epoch === pending.bindingEpoch),
      );
    if (
      !pending.reported &&
      status.outbox?.lease_token === pending.leaseToken &&
      pending.leaseUntil > status.server_now
    ) {
      await relay.api.dispatch.report(entry.agent, {
        lease_token: pending.leaseToken,
        consumer_binding_id: pending.bindingId,
        binding_epoch: pending.bindingEpoch,
        publish_gen: pending.publishGen,
        outcome: pending.outcome ?? (fetched ? "accepted" : "unknown"),
      });
      pending.reported = true;
      this.persist();
    }
    // Accepted Codex starts must not be repeated while their fetch watermark lags.
    // Unknown outcomes remain inspectable until fetched or explicitly unregistered.
    if (
      !fetched &&
      (pending.outcome === "accepted" ||
        !pending.outcome ||
        pending.outcome === "unknown")
    ) {
      entry.reason =
        "Wake outcome awaits a matching inbox fetch; delivery remains pending";
      this.persist();
      return true;
    }
    if (!pending.reported && pending.leaseUntil > status.server_now)
      return true;
    entry.pending = undefined;
    entry.reason = undefined;
    this.persist();
    return false;
  }
  tick(): Promise<void> {
    return this.serial(async () => {
      this.ledger.heartbeat = Date.now();
      this.persist();
      if (this.stopping) return;
      for (const entry of [...this.ledger.registrations]) {
        if (this.stopping) break;
        if (entry.state === "closing") {
          await this.remove(entry).catch(() => {});
          continue;
        }
        try {
          let relay = this.relays.get(entry.key);
          // Close orphaned relay authority even if its original occupant has died.
          if (!relay) await this.factory.recover(entry);
          const session = await this.discovery.discover(entry.key, entry);
          if (!relay) {
            // Proof keys are ephemeral. Close the old run before creating another.
            entry.relayOperationId = randomUUID();
            entry.relayRunId = undefined;
            this.persist();
            relay = await this.attach(entry, session);
          }
          if (await this.reconcile(entry, relay)) continue;
          const { lease } = await relay.api.dispatch.lease(entry.agent);
          if (!lease) continue;
          if (
            lease.consumer_binding_id !== entry.bindingId ||
            lease.binding_epoch !== entry.bindingEpoch ||
            lease.native_session_ref?.session_id !== session.state.sessionId ||
            lease.native_session_ref?.host_ref !== this.ledger.hostRef ||
            lease.native_session_ref?.profile_id !== entry.profile.id
          )
            throw new Error(
              "Dispatch lease does not address the registered session",
            );
          entry.pending = {
            leaseToken: lease.lease_token,
            leaseUntil: lease.lease_until,
            publishGen: lease.publish_gen,
            bindingId: lease.consumer_binding_id,
            bindingEpoch: lease.binding_epoch,
            startedAt: Date.now(),
            reported: false,
          };
          this.persist();
          // Discovery is repeated immediately before the external side effect.
          const current = await this.discovery.discover(entry.key, entry);
          entry.pending.outcome = await this.discovery.wake(
            current,
            lease.lease_token,
            entry.allowIdleStart && lease.allow_idle_start,
          );
          this.persist();
          await this.reconcile(entry, relay);
          entry.state = "active";
        } catch {
          entry.state = "paused";
          entry.reason =
            "Session verification or dispatch failed; retrying metadata reconciliation";
          this.persist();
          // Stop heartbeat authority when the occupant/account cannot be verified.
          const relay = this.relays.get(entry.key);
          if (relay) {
            await relay.close().catch(() => {});
            this.relays.delete(entry.key);
          }
        }
      }
    });
  }
  private async remove(entry: Registration): Promise<void> {
    entry.state = "closing";
    this.persist();
    const relay = this.relays.get(entry.key);
    if (relay) {
      await relay.close();
      this.relays.delete(entry.key);
    } else await this.factory.recover(entry);
    this.ledger.registrations.splice(
      this.ledger.registrations.indexOf(entry),
      1,
    );
    this.persist();
  }
  get stopped(): boolean {
    return this.stopping;
  }
  close(): Promise<void> {
    return this.serial(async () => {
      this.stopping = true;
      for (const entry of this.ledger.registrations) {
        const relay = this.relays.get(entry.key);
        if (relay) await relay.close().catch(() => {});
      }
      this.relays.clear();
      this.discovery.close();
      this.persist();
    });
  }
}
