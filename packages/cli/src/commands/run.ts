import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  Lifecycle,
  ProfileStore,
  SessionStore,
  connectRuntimeBroker,
  environmentMetadata,
  processIdentity,
  profileEnvironment,
} from "@tila/client-lifecycle";
import { defineCommand } from "citty";
import { createTila } from "tila-sdk";
import { credentialPolicyArgs, policyFromArgs } from "../lib/credential-policy";
import { globalFlagArgs } from "../lib/global-flags";
import { diagnostic, printJson } from "../lib/output";
import {
  runtimeOperatorClient,
  runtimeSelection,
  startEnrolledRun,
  startOidcRun,
} from "../lib/runtime";

const idArg = {
  id: {
    type: "positional" as const,
    required: true as const,
    description: "Run ID",
  },
};
export default defineCommand({
  meta: {
    name: "run",
    description: "Execute commands with isolated project access",
  },
  subCommands: {
    exec: defineCommand({
      args: {
        ...globalFlagArgs,
        ...credentialPolicyArgs,
        oidc: { type: "boolean", default: false },
        agent: {
          type: "string",
          description: "Agent ID pinned for the lifetime of this run",
        },
        profile: {
          type: "string",
          description:
            "Host-local provider profile; launches its registered executable",
        },
        preset: { ...credentialPolicyArgs.preset, default: "worker" },
      },
      async run({ args, rawArgs }) {
        const separator = rawArgs.indexOf("--");
        const command = separator >= 0 ? rawArgs.slice(separator + 1) : [];
        if (!command.length)
          throw new Error("Usage: tila run exec -- <command> [arguments]");
        if (process.env.TILA_RUN_SOCKET || process.env.TILA_RUN_CAPABILITY)
          throw new Error("Managed runs cannot create descendant runs");
        const profiles = new ProfileStore();
        const profile = args.profile ? profiles.get(args.profile) : undefined;
        if (profile) {
          await profiles.verify(profile.id, profile.revision);
          if (
            command[0] !== profile.launcher &&
            command[0] !== (profile.harness === "codex" ? "codex" : "claude")
          )
            throw new Error(
              "The command must match the selected profile launcher",
            );
          command[0] = profile.launcher;
        }
        const selection = await runtimeSelection();
        const { broker, reference } = await (args.oidc
          ? startOidcRun
          : startEnrolledRun)(selection, policyFromArgs(args), {
          agent_id: args.agent,
        });
        try {
          const connected = await connectRuntimeBroker(reference);
          const api = await createTila(
            {
              backend: "cloudflare",
              project_id: selection.projectId,
              worker_url: selection.deployment,
              schema_version: 0,
              tila_version: "0.4.0",
              created_at: new Date(0).toISOString(),
            },
            connected.provider,
            { participantId: connected.context.participant_id },
          );
          const lifecycle = new Lifecycle(
            new SessionStore(),
            JSON.stringify([selection.deployment, selection.projectId]),
            async () => api,
          );
          let state:
            | Awaited<ReturnType<Lifecycle["start"]>>["state"]
            | undefined;
          try {
            const started = await lifecycle.start(
              "cli",
              {
                session_id: broker.context.run_id,
                cwd: process.cwd(),
                hook_event_name: "SessionStart",
              },
              processIdentity(process.pid),
              environmentMetadata("cli", process.cwd()),
              {
                participantId: broker.context.participant_id,
                profile: profile
                  ? { id: profile.id, revision: profile.revision }
                  : undefined,
                reference: { ...reference, runId: broker.context.run_id },
              },
            );
            state = started.state;
            const env = profileEnvironment(profile);
            env.TILA_HOME = profiles.root;
            env.TILA_RUN_SOCKET = reference.socket;
            env.TILA_RUN_CAPABILITY = reference.capability;
            env.TILA_PARTICIPANT_ID = broker.context.participant_id;
            const child = spawn(command[0], command.slice(1), {
              stdio: "inherit",
              env,
            });
            const forward = (signal: NodeJS.Signals) => {
              child.kill(signal);
            };
            const sigint = () => forward("SIGINT");
            const sigterm = () => forward("SIGTERM");
            process.on("SIGINT", sigint);
            process.on("SIGTERM", sigterm);
            let profileFailure: unknown;
            let checking = false;
            const profileCheck = profile
              ? setInterval(() => {
                  if (checking) return;
                  checking = true;
                  void profiles
                    .verify(profile.id, profile.revision)
                    .catch((error) => {
                      profileFailure = error;
                      child.kill("SIGTERM");
                      void broker.close();
                    })
                    .finally(() => {
                      checking = false;
                    });
                }, 30_000)
              : undefined;
            const heartbeat = setInterval(() => {
              if (state)
                void lifecycle
                  .tick(state.key, state.generation, true)
                  .catch(() => {});
            }, 60_000);
            try {
              process.exitCode = await new Promise<number>(
                (resolve, reject) => {
                  child.once("error", reject);
                  child.once("exit", (code, signal) =>
                    resolve(code ?? (signal === "SIGINT" ? 130 : 143)),
                  );
                },
              );
            } finally {
              clearInterval(heartbeat);
              if (profileCheck) clearInterval(profileCheck);
              process.off("SIGINT", sigint);
              process.off("SIGTERM", sigterm);
            }
            if (profileFailure) throw profileFailure;
          } finally {
            try {
              if (state) {
                await lifecycle.end(state.key);
                const deadline = Date.now() + 300_000;
                const ending = state;
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                  await Promise.race([
                    (async () => {
                      while (
                        Date.now() < deadline &&
                        (await lifecycle.tick(
                          ending.key,
                          ending.generation,
                          true,
                        ))
                      )
                        await delay(1000);
                    })(),
                    new Promise<void>((resolve) => {
                      timer = setTimeout(resolve, 300_000);
                    }),
                  ]);
                } finally {
                  if (timer) clearTimeout(timer);
                }

                if (lifecycle.store.read(state.key)?.phase !== "closed")
                  diagnostic(
                    "Run cleanup incomplete; access is closing and remaining claims will expire normally.",
                  );
              }
            } finally {
              api.close();
            }
          }
        } finally {
          await broker.close();
        }
      },
    }),
    list: defineCommand({
      args: { ...globalFlagArgs },
      async run() {
        printJson(
          await (await runtimeOperatorClient(await runtimeSelection())).runs(),
        );
      },
    }),
    inspect: defineCommand({
      args: { ...globalFlagArgs, ...idArg },
      async run({ args }) {
        const result = await (
          await runtimeOperatorClient(await runtimeSelection())
        ).runs();
        const run = result.runs.find((row) => row.run_id === args.id);
        if (!run) throw new Error("Run is not accessible");
        printJson({ ok: true, run });
      },
    }),
    revoke: defineCommand({
      args: { ...globalFlagArgs, ...idArg },
      async run({ args }) {
        printJson(
          await (
            await runtimeOperatorClient(await runtimeSelection())
          ).revokeRun(args.id),
        );
      },
    }),
  },
});
