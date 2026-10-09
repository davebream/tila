import { createHash } from "node:crypto";
import { join } from "node:path";
import { type ProfileStore, processAlive } from "@tila/client-lifecycle";
import {
  type LaunchIntent,
  LaunchIntentSchema,
  type LaunchRequest,
  LaunchRequestSchema,
} from "@tila/schemas";
import lockfile from "proper-lockfile";
import {
  type ConnectorStore,
  atomicPrivate,
  privateDirectory,
  readPrivate,
} from "./store";

export type { LaunchRequest, LaunchIntent } from "@tila/schemas";

export interface LaunchDriver {
  /** Must verify native session, acting run and profile, never just a pane label. */
  discover(request: LaunchRequest): Promise<string | null>;
  spawn(request: LaunchRequest): Promise<{
    process: NonNullable<LaunchIntent["process"]>;
    exited: Promise<number | null>;
  }>;
}
/** A separate local lock permits attended launch without passing launchers over the control socket. */
export class NativeLaunch {
  constructor(
    readonly store: ConnectorStore,
    readonly profiles: Pick<ProfileStore, "verify">,
    readonly driver: LaunchDriver,
  ) {}
  async open(raw: LaunchRequest): Promise<LaunchIntent> {
    const request = LaunchRequestSchema.parse(raw);
    const root = join(this.store.root, "launches");
    privateDirectory(root);
    const name = createHash("sha256").update(request.operationId).digest("hex");
    const path = join(root, `${name}.json`);
    const release = await lockfile.lock(root, {
      lockfilePath: `${path}.lock`,
      realpath: false,
      stale: 60_000,
      update: 10_000,
      retries: 0,
    });
    try {
      await this.profiles.verify(request.profile, request.profileRevision);
      let existing: LaunchIntent | undefined;
      try {
        existing = LaunchIntentSchema.parse(JSON.parse(readPrivate(path)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (
        existing &&
        JSON.stringify(existing.request) !== JSON.stringify(request)
      )
        throw new Error("Launch operation identity changed");
      const discoveredKey = await this.driver.discover(request);
      if (existing) {
        if (existing.state !== "exited") {
          existing.state =
            discoveredKey ||
            (existing.process && processAlive(existing.process))
              ? "running"
              : "uncertain";
          existing.discoveredKey = discoveredKey ?? undefined;
          atomicPrivate(path, existing);
        }
        return existing; // Never respawn an uncertain operation.
      }
      const intent: LaunchIntent = {
        request,
        createdAt: Date.now(),
        state: discoveredKey ? "running" : "launching",
        process: null,
        discoveredKey: discoveredKey ?? undefined,
      };
      atomicPrivate(path, intent);
      if (discoveredKey) return intent;
      try {
        const child = await this.driver.spawn(request);
        intent.process = child.process;
        intent.state = "running";
        atomicPrivate(path, intent);
        intent.exitCode = await child.exited;
        intent.state = "exited";
        atomicPrivate(path, intent);
      } catch (error) {
        intent.state = "uncertain";
        atomicPrivate(path, intent);
        throw error;
      }
      return intent;
    } finally {
      await release();
    }
  }
}
