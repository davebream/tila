import {
  type MembershipPrincipal,
  ProjectMembershipModeSchema,
  ProjectRoleSchema,
} from "@tila/schemas";
import { defineCommand } from "citty";
import { createMembershipMethods } from "tila-sdk";
import { requireClient, resolveContext } from "../context";
import { globalFlagArgs } from "../lib/global-flags";
import { printJson } from "../lib/output";

async function api() {
  const ctx = await resolveContext();
  return createMembershipMethods(requireClient(ctx), ctx.config.project_id);
}

const idArg = {
  ...globalFlagArgs,
  membership: {
    type: "positional" as const,
    required: true as const,
    description: "Membership ID (from member list)",
  },
};

/** One flag per principal kind; exactly one must be given. */
function principal(args: {
  user?: string;
  service?: string;
  github?: string;
  "github-host"?: string;
  "oidc-issuer"?: string;
  "oidc-subject"?: string;
}): { principal: MembershipPrincipal; kind: "human" | "service" } {
  const given = [
    args.user,
    args.service,
    args.github,
    args["oidc-issuer"],
  ].filter((value) => value !== undefined);
  if (given.length !== 1)
    throw new Error(
      "Pass exactly one of --user, --service, --github or --oidc-issuer",
    );
  if (args.user)
    return { principal: { provider: "user", id: args.user }, kind: "human" };
  if (args.service)
    return {
      principal: { provider: "service", id: args.service },
      kind: "service",
    };
  if (args.github) {
    const userId = Number(args.github);
    if (!Number.isInteger(userId) || userId < 1)
      throw new Error("--github takes a numeric GitHub user ID");
    return {
      principal: {
        provider: "github",
        host: args["github-host"] ?? "github.com",
        user_id: userId,
      },
      kind: "human",
    };
  }
  if (!args["oidc-subject"])
    throw new Error("--oidc-issuer needs --oidc-subject");
  return {
    principal: {
      provider: "oidc",
      issuer: args["oidc-issuer"] as string,
      subject: args["oidc-subject"],
    },
    kind: "human",
  };
}

export default defineCommand({
  meta: {
    name: "member",
    description:
      "Manage canonical project memberships (owner); revocation applies on the next request",
  },
  subCommands: {
    list: defineCommand({
      args: globalFlagArgs,
      async run() {
        printJson(await (await api()).list());
      },
    }),
    grant: defineCommand({
      meta: { description: "Grant a role; an existing grant keeps its role" },
      args: {
        ...globalFlagArgs,
        role: { type: "string", required: true },
        user: { type: "string", description: "Email account user ID (UUID)" },
        service: { type: "string", description: "Service account ID (UUID)" },
        github: { type: "string", description: "Numeric GitHub user ID" },
        "github-host": { type: "string" },
        "oidc-issuer": { type: "string" },
        "oidc-subject": { type: "string" },
        "display-name": { type: "string" },
      },
      async run({ args }) {
        const { principal: target, kind } = principal(args);
        printJson(
          await (await api()).grant({
            principal: target,
            subject_kind: kind,
            role: ProjectRoleSchema.parse(args.role),
            display_name: args["display-name"],
          }),
        );
      },
    }),
    role: defineCommand({
      meta: {
        description: "Change a role; demoting the last owner is refused",
      },
      args: { ...idArg, role: { type: "string", required: true } },
      async run({ args }) {
        printJson(
          await (await api()).updateRole(
            args.membership,
            ProjectRoleSchema.parse(args.role),
          ),
        );
      },
    }),
    revoke: defineCommand({
      meta: {
        description:
          "Revoke a membership and its sessions; the last owner cannot be revoked",
      },
      args: idArg,
      async run({ args }) {
        printJson(await (await api()).revoke(args.membership));
      },
    }),
    policy: defineCommand({
      meta: {
        description:
          "Show the membership mode, or change it with --set explicit|hybrid|github-mirrored",
      },
      args: { ...globalFlagArgs, set: { type: "string" } },
      async run({ args }) {
        const client = await api();
        printJson(
          args.set
            ? await client.setPolicy(
                ProjectMembershipModeSchema.parse(args.set),
              )
            : await client.policy(),
        );
      },
    }),
    events: defineCommand({
      args: {
        ...globalFlagArgs,
        cursor: { type: "string" },
        limit: { type: "string", default: "50" },
      },
      async run({ args }) {
        printJson(
          await (await api()).events({
            cursor: args.cursor === undefined ? undefined : Number(args.cursor),
            limit: Number(args.limit),
          }),
        );
      },
    }),
  },
});
