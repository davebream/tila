import { Cli, z } from "incur";
// Deterministic coordination fixture; production continues to use tila-sdk.
const claims = new Map<string, { participant: string; fence: number }>();
let fence = 0;
const identity = z.object({ participant: z.string().default("fallback") });
const cli = Cli.create("tila-trial", {
  globals: z.object({ project: z.string().default("project") }),
  mcp: { tools: { discovery: "direct" } },
})
  .command("reentry", {
    mcp: { name: "tila_reentry" },
    options: identity,
    output: z.object({
      ok: z.literal(true),
      participant: z.string(),
      claims: z.array(z.string()),
    }),
    run(c) {
      return {
        ok: true as const,
        participant: c.options.participant,
        claims: [...claims]
          .filter(([, value]) => value.participant === c.options.participant)
          .map(([key]) => key),
      };
    },
  })
  .command("acquire", {
    mcp: { name: "tila_claim_acquire" },
    args: z.object({ resource: z.string() }),
    options: identity,
    output: z.object({
      ok: z.literal(true),
      fence: z.number(),
      participant: z.string(),
    }),
    run(c) {
      if (claims.has(c.args.resource))
        return c.error({
          code: "CLAIM_CONFLICT",
          message: "Resource is already claimed",
        });
      const claim = { participant: c.options.participant, fence: ++fence };
      claims.set(c.args.resource, claim);
      return { ok: true as const, ...claim };
    },
  })
  .command("release", {
    mcp: { name: "tila_claim_release" },
    args: z.object({ resource: z.string() }),
    options: identity.extend({ fence: z.coerce.number().int() }),
    output: z.object({ ok: z.literal(true) }),
    run(c) {
      const claim = claims.get(c.args.resource);
      if (!claim || claim.fence !== c.options.fence)
        return c.error({
          code: "STALE_FENCE",
          message: "Fence does not match",
        });
      if (claim.participant !== c.options.participant)
        return c.error({
          code: "PARTICIPANT_MISMATCH",
          message: "Another participant owns this claim",
        });
      claims.delete(c.args.resource);
      return { ok: true as const };
    },
  });
await cli.serve();
