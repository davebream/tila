import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { RuntimeSelector } from "@tila/schemas";
import type { WakeOutcome } from "./claude";
import {
  type DiscoveredSession,
  type SessionDiscovery,
  StandaloneDiscovery,
  assertSameSession,
} from "./discovery";
import {
  type HerdrReadClient,
  HerdrRuntimeAdapter,
  HerdrSocketClient,
} from "./herdr";
import type { Registration } from "./store";

/** A reference is stable across retries; only the observed incarnation grants eligibility. */
function serverRef(socket: string): string {
  const hex = createHash("sha256").update(`tila:herdr:${socket}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function runtimeSelector(entry: Registration): RuntimeSelector {
  return entry.runtime.kind === "herdr"
    ? {
        kind: "herdr",
        socket: entry.runtime.socket,
        paneId: entry.runtime.observation.pane_id,
      }
    : { kind: "standalone" };
}
export class CompositeDiscovery implements SessionDiscovery {
  private adapters = new Map<string, HerdrRuntimeAdapter>();
  constructor(
    readonly native: SessionDiscovery & {
      assertCurrent(session: DiscoveredSession): void;
    } = new StandaloneDiscovery(),
    readonly client: (socket: string) => HerdrReadClient = (socket) =>
      new HerdrSocketClient(socket),
  ) {}
  private adapter(socket: string): HerdrRuntimeAdapter {
    let adapter = this.adapters.get(socket);
    if (!adapter) {
      if (this.adapters.size >= 64)
        throw new Error("Herdr observation target limit reached");
      adapter = new HerdrRuntimeAdapter(serverRef(socket), this.client(socket));
      this.adapters.set(socket, adapter);
    }
    return adapter;
  }
  async discover(
    key: string,
    expected?: Registration,
    requested?: RuntimeSelector,
  ): Promise<DiscoveredSession> {
    const target =
      requested ??
      (expected ? runtimeSelector(expected) : { kind: "standalone" as const });
    const socket =
      target.kind === "herdr"
        ? join(realpathSync(dirname(target.socket)), basename(target.socket))
        : undefined;
    if (
      expected &&
      (expected.runtime.kind !== target.kind ||
        (expected.runtime.kind === "herdr" &&
          target.kind === "herdr" &&
          (expected.runtime.socket !== socket ||
            expected.runtime.observation.pane_id !== target.paneId)))
    )
      throw new Error("Runtime target differs; unregister explicitly first");
    const session = await this.native.discover(key, expected);
    if (target.kind === "standalone")
      return { ...session, runtime: { kind: "standalone" } };
    const adapter = this.adapter(socket as string);
    try {
      const observation = await adapter.observe(
        session,
        target.paneId,
        expected?.runtime.kind === "herdr"
          ? expected.runtime.observation
          : undefined,
        () => this.native.assertCurrent(session),
      );
      // Herdr I/O extends the native verification interval: recheck broker and account too.
      const fresh = await this.native.discover(key, expected);
      assertSameSession(session, fresh);
      this.native.assertCurrent(fresh);
      adapter.assertCurrent(observation);
      const near = await adapter.observe(
        fresh,
        target.paneId,
        observation,
        () => this.native.assertCurrent(fresh),
      );
      this.native.assertCurrent(fresh);
      adapter.assertCurrent(near);
      return {
        ...fresh,
        runtime: { kind: "herdr", socket: socket as string, observation: near },
      };
    } catch (error) {
      adapter.invalidate();
      throw error;
    }
  }
  async wake(
    session: DiscoveredSession,
    nonce: string,
    allowIdleStart: boolean,
  ): Promise<WakeOutcome> {
    if (session.runtime?.kind !== "herdr")
      return this.native.wake(session, nonce, allowIdleStart);
    const association = session.runtime;
    const adapter = this.adapter(association.socket);
    let observation = association.observation;
    return this.native.wake(
      session,
      nonce,
      allowIdleStart,
      async () => {
        try {
          observation = await adapter.observe(
            session,
            association.observation.pane_id,
            association.observation,
            () => this.native.assertCurrent(session),
          );
          const fresh = await this.native.discover(session.state.key);
          assertSameSession(session, fresh);
          this.native.assertCurrent(session);
          adapter.assertCurrent(observation);
          observation = await adapter.observe(
            session,
            association.observation.pane_id,
            observation,
            () => this.native.assertCurrent(session),
          );
          this.native.assertCurrent(session);
          adapter.assertCurrent(observation);
        } catch (error) {
          adapter.invalidate();
          throw error;
        }
      },
      () => {
        this.native.assertCurrent(session);
        adapter.assertCurrent(observation);
      },
    );
  }
  close(): void {
    for (const adapter of this.adapters.values()) adapter.invalidate();
    this.adapters.clear();
    this.native.close();
  }
}
