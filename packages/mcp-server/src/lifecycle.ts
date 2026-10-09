import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TilaFacade } from "tila-sdk";
import type { McpServerConfig } from "./config";
import { buildFacade } from "./facade";

/** Lazy method forwarding also covers tool modules which capture facade.claims at registration. */
export function scopedFacade(
  storage: AsyncLocalStorage<TilaFacade>,
): TilaFacade {
  const proxy = (path: PropertyKey[]): unknown =>
    new Proxy(() => {}, {
      get: (_target, key) => proxy([...path, key]),
      apply: (_target, _thisArg, args) => {
        let value: unknown = storage.getStore();
        if (!value)
          throw new Error(
            "runtime-session-unavailable: no authenticated request scope",
          );
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

/** Wrap protocol handlers, including discovery, resources and prompts. */
export function lifecycleTools(
  server: McpServer,
  config: McpServerConfig,
): { server: McpServer; facade: TilaFacade } {
  const storage = new AsyncLocalStorage<TilaFacade>();
  const protocol = server.server;
  const register = protocol.setRequestHandler.bind(protocol);
  protocol.setRequestHandler = ((
    schema: Parameters<typeof register>[0],
    handler: Parameters<typeof register>[1],
  ) => {
    return register(schema, async (request, extra) => {
      const meta = request.params?._meta;
      const facade = await buildFacade(config, meta);
      try {
        return await storage.run(facade, () => handler(request, extra));
      } finally {
        facade.close();
      }
    });
  }) as typeof protocol.setRequestHandler;
  return { server, facade: scopedFacade(storage) };
}
