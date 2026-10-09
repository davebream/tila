import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { selectedProfile } from "@tila/client-lifecycle";
import {
  CodexObserver,
  Lifecycle,
  ProfileStore,
  SessionStore,
  clientOwner,
  connectRuntimeBroker,
  environmentMetadata,
  processAlive,
  processIdentity,
  profileEnvironment,
  sessionKey,
} from "@tila/client-lifecycle";
import {
  type LifecycleClient,
  LifecycleEventSchema,
  type LifecycleState,
} from "@tila/schemas";
import { type TilaFacade, createTila } from "tila-sdk";
import { findConfig } from "../config";
import { diagnostic, outputText, protocolJson } from "./output";
import { startEnrolledRun } from "./runtime";

export function lifecycleNamespace(cwd?: string): string {
  const config = findConfig(cwd);
  if (!config?.worker_url || config.backend === "local")
    throw new Error(
      "Lifecycle integration requires a configured Cloudflare project",
    );
  return JSON.stringify([
    config.worker_url.replace(/\/+$/, ""),
    config.project_id,
  ]);
}
export function cliInvocation(): string[] {
  if (!/^(bun|node)(\.exe)?$/.test(basename(process.execPath)))
    return [process.execPath];
  const execArgs = process.execArgv.map((arg, index, args) =>
    args[index - 1] === "--tsconfig-override" ? resolve(arg) : arg,
  );
  return [process.execPath, ...execArgs, resolve(process.argv[1])];
}
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function runtime(store = new SessionStore()): {
  lifecycle: Lifecycle;
  close: () => void;
} {
  const namespace = lifecycleNamespace();
  const facades = new Map<string, TilaFacade>();
  const lifecycle = new Lifecycle(store, namespace, async (state) => {
    if (state.namespace !== namespace)
      throw new Error("Project configuration changed; lifecycle stopped");
    let api = facades.get(state.participantId);
    if (!api) {
      const config = findConfig();
      if (!config) throw new Error("Project configuration is missing");
      if (!state.runtime) throw new Error("Runtime initialization pending");
      const connected = await connectRuntimeBroker(state.runtime);
      if (connected.context.participant_id !== state.participantId)
        throw new Error("Runtime participant mismatch");
      api = await createTila(config, connected.provider, {
        participantId: state.participantId,
        environment: state.environment,
        timeoutMs: 1200,
      });
      facades.set(state.participantId, api);
    }
    return api;
  });
  return {
    lifecycle,
    close: () => {
      for (const api of facades.values()) api.close();
    },
  };
}
export async function ensureWorker(
  store: SessionStore,
  state: LifecycleState,
): Promise<void> {
  await store.locked(state.key, async () => {
    const latest = store.read(state.key);
    if (
      !latest ||
      latest.phase === "closed" ||
      latest.phase === "crashed" ||
      processAlive(latest.worker)
    )
      return;
    if (latest.runtime) {
      // A crashed helper cannot recover its ephemeral run proof key. Never
      // silently replace the authentication of an existing conversation.
      latest.phase = "crashed";
      latest.degraded =
        "Run helper stopped; start a replacement session to recover through handoffs.";
      store.write(latest);
      return;
    }
    const [command, ...args] = cliInvocation();
    const child = spawn(
      command,
      [...args, "lifecycle", "worker", latest.key, latest.generation],
      { cwd: latest.cwd, stdio: "ignore", detached: true },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    latest.worker = child.pid ? processIdentity(child.pid) : null;
    if (!latest.worker) {
      child.kill();
      throw new Error("Could not verify heartbeat worker");
    }
    store.write(latest);
    child.unref();
  });
}

export async function runLifecycleHook(
  client: LifecycleClient,
  input: unknown,
): Promise<void> {
  const event = LifecycleEventSchema.parse(input);
  process.chdir(event.cwd);
  const { lifecycle, close } = runtime();
  const key = sessionKey(
    lifecycle.namespace,
    client,
    event.session_id,
    selectedProfile(),
  );
  try {
    if (event.hook_event_name === "SessionStart") {
      const owner = clientOwner(client);
      let { state, text } = await lifecycle.start(
        client,
        event,
        owner,
        environmentMetadata(client, event.cwd),
      );
      await ensureWorker(lifecycle.store, state);
      const deadline = Date.now() + 8000;
      while (
        !state.runtime &&
        state.phase === "active" &&
        Date.now() < deadline
      ) {
        await delay(100);
        state = lifecycle.store.read(key) ?? state;
      }
      if (state.runtime)
        ({ state, text } = await lifecycle.start(
          client,
          event,
          owner,
          environmentMetadata(client, event.cwd),
        ));
      let warning =
        client === "claude-code" && !owner
          ? "Tila lifecycle degraded: cannot identify the Claude Code runtime. Use its native CLI installation; presence will remain offline."
          : state.degraded;
      try {
        if (client === "claude-code" && process.env.CLAUDE_ENV_FILE) {
          appendFileSync(
            process.env.CLAUDE_ENV_FILE,
            `\nexport TILA_LIFECYCLE_KEY=${shellQuote(state.key)}\n`,
          );
        }
        await ensureWorker(lifecycle.store, state);
      } catch {
        warning =
          "Tila lifecycle degraded: could not attach session environment or start heartbeat worker. Run tila lifecycle status.";
        diagnostic(warning);
      }
      protocolJson({
        ...(warning ? { systemMessage: warning } : {}),
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: text,
        },
      });
    } else if (event.hook_event_name === "SessionEnd") {
      await lifecycle.end(key);
      const state = lifecycle.store.read(key);
      if (state) await ensureWorker(lifecycle.store, state);
    } else {
      await lifecycle.observe(key);
      const state = lifecycle.store.read(key);
      if (state?.phase === "active") await ensureWorker(lifecycle.store, state);
      if (event.hook_event_name === "UserPromptSubmit" && state?.degraded) {
        const recovered = await lifecycle.start(
          client,
          event,
          clientOwner(client),
          environmentMetadata(client, event.cwd),
        );
        let warning = recovered.state.degraded;
        try {
          await ensureWorker(lifecycle.store, recovered.state);
        } catch {
          warning =
            "Tila lifecycle degraded: could not start heartbeat worker. Run tila lifecycle status.";
        }
        protocolJson({
          ...(warning ? { systemMessage: warning } : {}),
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: recovered.text,
          },
        });
      }
    }
  } finally {
    close();
  }
}

export async function runLifecycleWorker(
  key: string,
  generation: string,
): Promise<void> {
  const store = new SessionStore();
  // Wait for the spawning hook to publish our process identity.
  const initial = await store.locked(key, async () => store.read(key));
  if (!initial || initial.generation !== generation) return;
  process.chdir(initial.cwd);
  if (initial.runtime)
    throw new Error("An existing run cannot be resumed after helper loss");
  const config = findConfig();
  if (!config?.worker_url) throw new Error("Remote configuration is required");
  const profileStore = new ProfileStore();
  const profile = initial.profile
    ? profileStore.get(initial.profile.id, initial.profile.revision)
    : undefined;
  if (profile) await profileStore.verify(profile.id, profile.revision);
  const managed = await startEnrolledRun({
    deployment: new URL(config.worker_url).origin,
    projectId: config.project_id,
  });
  try {
    await store.locked(key, async () => {
      const state = store.read(key);
      if (
        !state ||
        state.generation !== generation ||
        state.worker?.pid !== process.pid
      )
        throw new Error("Session generation changed during runtime creation");
      state.runtime = {
        ...managed.reference,
        runId: managed.broker.context.run_id,
      };
      state.participantId = managed.broker.context.participant_id;
      store.write(state);
    });
  } catch (error) {
    await managed.broker.close().catch(() => {});
    throw error;
  }
  const { lifecycle, close } = runtime(store);
  const observer = new CodexObserver(
    profile?.harness === "codex" ? profile.launcher : undefined,
    profile ? profileEnvironment(profile) : undefined,
  );
  let closingSince: number | undefined;
  try {
    for (;;) {
      const state = store.read(key);
      if (
        !state ||
        state.generation !== generation ||
        state.worker?.pid !== process.pid
      )
        return;
      if (profile) await profileStore.verify(profile.id, profile.revision);
      let alive = processAlive(state.owner);
      if (state.client === "codex" && state.phase === "active") {
        try {
          alive = await observer.alive(state.sessionId);
        } catch {
          // Unknown liveness must never keep a phantom participant online.
          await store.locked(key, async () => {
            const latest = store.read(key);
            if (latest?.generation === generation) {
              latest.degraded =
                "Cannot verify Codex session status; heartbeats paused. Check codex app-server proxy.";
              store.write(latest);
            }
          });
          await lifecycle.tick(key, generation, false);
          return;
        }
      }
      if (!(await lifecycle.tick(key, generation, alive))) return;
      const latest = store.read(key);
      if (latest?.phase === "closing") {
        closingSince ??= Date.now();
        if (Date.now() - closingSince > 300_000) {
          return; // Persist the outbox for explicit retry, never retry forever.
        }
      }
      await delay(latest?.phase === "closing" ? 1000 : 15_000);
    }
  } finally {
    observer.close();
    close();
    let closureConfirmed = true;
    await managed.broker.close().catch(() => {
      closureConfirmed = false;
    });
    // A clean end can race the monitor's final liveness check. Publish that this
    // helper is leaving so an end hook never relies on an exiting process.
    const pending = await store.locked(key, async () => {
      const latest = store.read(key);
      if (
        !latest ||
        latest.generation !== generation ||
        latest.worker?.pid !== process.pid
      )
        return null;
      latest.worker = null;
      if (!closureConfirmed)
        latest.degraded =
          "Local runtime access stopped; server closure could not be confirmed. The run lease will expire within five minutes.";
      store.write(latest);
      return latest.phase === "closing" ? latest : null;
    });
    if (pending)
      await store.locked(key, async () => {
        const state = store.read(key);
        if (state?.generation === generation) {
          state.phase = "crashed";
          state.degraded = closureConfirmed
            ? "Cleanup incomplete; runtime access is closed. Remaining claims expire normally."
            : "Cleanup incomplete; local runtime access stopped but server closure could not be confirmed. The run lease and remaining claims expire normally.";
          store.write(state);
        }
      });
  }
}
