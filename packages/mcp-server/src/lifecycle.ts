import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SessionStore, clientOwner, sessionKey } from "@tila/client-lifecycle";
import { LifecycleClientSchema, type LifecycleState } from "@tila/schemas";
import type { TilaFacade } from "tila-sdk";
import type { McpServerConfig } from "./config";
import { buildFacade } from "./facade";
import { toolFailure } from "./tool-registration";

/** Lazy method forwarding also covers tool modules which capture facade.claims at registration. */
export function scopedFacade(
  storage: AsyncLocalStorage<TilaFacade>,
  fallback: TilaFacade,
): TilaFacade {
  const proxy = (path: PropertyKey[]): unknown =>
    new Proxy(() => {}, {
      get: (_target, key) => proxy([...path, key]),
      apply: (_target, _thisArg, args) => {
        let value: unknown = storage.getStore() ?? fallback;
        let parent: unknown;
        for (const key of path) {
          parent = value;
          value = (value as Record<PropertyKey, unknown>)[key];
        }
        return Reflect.apply(
          value as (...args: unknown[]) => unknown,
          parent,
          args,
        );
      },
    });
  return proxy([]) as TilaFacade;
}

export function lifecycleTools(
  server: McpServer,
  config: McpServerConfig,
  fallback: TilaFacade,
): { server: McpServer; facade: TilaFacade } {
  const configured = process.env.TILA_LIFECYCLE_CLIENT;
  if (!configured) return { server, facade: fallback };
  const client = LifecycleClientSchema.parse(configured);
  if (config.mode !== "remote")
    throw new Error("Lifecycle integration requires a Cloudflare project");
  const namespace = JSON.stringify([
    config.apiUrl.replace(/\/+$/, ""),
    config.projectId,
  ]);
  const store = new SessionStore();
  const storage = new AsyncLocalStorage<TilaFacade>();
  const realTool = server.tool?.bind(server) as (...args: unknown[]) => unknown;
  const realRegister = server.registerTool.bind(server) as (
    ...args: unknown[]
  ) => unknown;
  return {
    facade: scopedFacade(storage, fallback),
    server: new Proxy(server, {
      get(target, prop, receiver) {
        if (prop !== "tool" && prop !== "registerTool") {
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (...registration: unknown[]) => {
          const handler = registration.at(-1) as (
            ...args: unknown[]
          ) => unknown;
          const wrapped = async (...args: unknown[]) => {
            const extra = args.at(-1) as
              | { _meta?: { sessionId?: string; threadId?: string } }
              | undefined;
            const meta = extra?._meta;
            let state: LifecycleState | null | undefined;
            if (client === "codex") {
              // Shared daemons reuse MCP connections. Never bind process-global identity.
              const session = meta?.sessionId ?? meta?.threadId;
              if (typeof session !== "string")
                throw new Error(
                  "Tila lifecycle degraded: Codex did not supply per-request session metadata. Restart after installing supported hooks.",
                );
              state = store.read(sessionKey(namespace, client, session));
            } else {
              const owner = clientOwner(client);
              const matches = store
                .list()
                .filter(
                  (entry) =>
                    entry.namespace === namespace &&
                    entry.client === client &&
                    entry.phase === "active" &&
                    owner &&
                    entry.owner?.pid === owner.pid &&
                    entry.owner.started === owner.started,
                );
              if (matches.length === 1) state = matches[0];
            }
            if (!state || state.phase !== "active")
              throw new Error(
                "Tila lifecycle degraded: no unambiguous active session. Local work can continue; restart the client to restore Tila integration.",
              );
            const facade = await buildFacade(config, {
              participantId: state.participantId,
              environment: state.environment,
            });
            try {
              return await storage.run(facade, () => handler(...args));
            } finally {
              facade.close();
            }
          };
          const register = prop === "registerTool" ? realRegister : realTool;
          return register(
            ...registration.slice(0, -1),
            async (...args: unknown[]) => {
              try {
                return await wrapped(...args);
              } catch (error) {
                return toolFailure(error);
              }
            },
          );
        };
      },
    }),
  };
}
