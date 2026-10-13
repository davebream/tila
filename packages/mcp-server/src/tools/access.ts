import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TilaFacade } from "tila-sdk";
import { z } from "zod";
import { registerPrimitiveTool } from "../tool-registration";

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

/**
 * Read-only access inspection (opt-in `access` group, project owners).
 * Memberships, repository policy, service identities and credentials are
 * changed only through the dashboard, CLI or SDK, never through MCP.
 */
export function registerAccessTools(
  server: McpServer,
  facade: Pick<
    TilaFacade,
    "memberships" | "repos" | "serviceAccounts" | "tokens"
  >,
  _projectId: string,
): void {
  registerPrimitiveTool(
    server,
    "tila_access_members",
    "List canonical project memberships and roles (owners only). Read-only.",
    {},
    async () => text(await facade.memberships.list()),
  );
  registerPrimitiveTool(
    server,
    "tila_access_repos",
    "List linked repositories with their human access and Actions OIDC policies and revisions (owners only). Read-only.",
    { host: z.string().optional() },
    async ({ host }) => text(await facade.repos.list({ host })),
  );
  registerPrimitiveTool(
    server,
    "tila_access_service_accounts",
    "List service identities (owners only). Read-only.",
    {},
    async () => text(await facade.serviceAccounts.list()),
  );
  registerPrimitiveTool(
    server,
    "tila_access_credentials",
    "List scoped credential metadata: names, roles, capabilities and expiry. Never returns secret values. Owners only; read-only.",
    {},
    async () => text(await facade.tokens.list()),
  );
}
