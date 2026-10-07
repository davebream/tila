import { CliSuccessEnvelopeSchema } from "@tila/schemas";
import { expect, it } from "vitest";
import { successEnvelope, withOutput } from "../../lib/output";

it("scopes limits independently and preserves non-list objects", async () => {
  const page = (limit: number) =>
    withOutput({ json: false, limit }, async () => {
      await Promise.resolve();
      return successEnvelope({ items: [1, 2, 3], total: 9, offset: 2 });
    });
  const [one, two] = await Promise.all([page(1), page(2)]);
  expect(one).toEqual({
    ok: true,
    result: { items: [1] },
    meta: { count: 1, limit: 1, total: 9, offset: 2, truncated: true },
  });
  expect(two.meta?.count).toBe(2);
  expect(CliSuccessEnvelopeSchema.safeParse(one).success).toBe(true);
  expect(CliSuccessEnvelopeSchema.safeParse({ ok: true }).success).toBe(false);
  expect(
    successEnvelope({ resolved: "one", instances: [1, 2] }).result,
  ).toEqual({ resolved: "one", instances: [1, 2] });
});
it("does not invent cursors and distinguishes unknown completeness", async () => {
  const result = await withOutput({ json: false, limit: 2 }, async () =>
    successEnvelope({ items: [1, 2], next_cursor: "truncated" }),
  );
  expect(result.meta).toMatchObject({ count: 2, limit: 2, truncated: true });
  expect(result.meta?.next_cursor).toBeUndefined();
  const unknown = await withOutput({ json: false, limit: 2 }, async () =>
    successEnvelope([1, 2]),
  );
  expect(unknown.meta?.has_more_unknown).toBe(true);
  expect(unknown.meta?.truncated).toBeUndefined();
});
