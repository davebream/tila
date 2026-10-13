import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";

/** MSW handlers for the definitions pages: applied revision, preview, apply. */

/** Serve `GET /schema` from a mutable applied revision. */
export function appliedAt(state: { revision: number; source: string | null }) {
  server.use(
    http.get("*/projects/*/schema", () =>
      HttpResponse.json({
        ok: true,
        schema:
          state.source === null
            ? null
            : {
                version: state.revision,
                definition: state.source,
                applied_at: Date.now(),
                applied_by: "someone",
              },
        version: state.source === null ? null : state.revision,
        revision: state.revision,
      }),
    ),
  );
}

export type Sent = { body: Record<string, unknown>; key: string | null };

export function previewAt(
  revision: () => number,
  answer: (definition: string) => Record<string, unknown> = () => ({
    changes: [],
    autoApplicable: true,
  }),
) {
  const sent: string[] = [];
  server.use(
    http.post("*/projects/*/schema/preview", async ({ request }) => {
      const { definition } = (await request.json()) as { definition: string };
      sent.push(definition);
      return HttpResponse.json({
        ok: true,
        revision: revision(),
        reviewed_definition: definition,
        ...answer(definition),
      });
    }),
  );
  return sent;
}

export function applyWith(...responses: Array<() => Response>) {
  const sent: Sent[] = [];
  server.use(
    http.post("*/projects/*/schema", async ({ request }) => {
      sent.push({
        body: (await request.json()) as Record<string, unknown>,
        key: request.headers.get("Idempotency-Key"),
      });
      return (responses[sent.length - 1] ?? responses[responses.length - 1])();
    }),
  );
  return sent;
}

export const ok = (revision: number) => () =>
  HttpResponse.json({ ok: true, version: revision, revision, changes: [] });

export function whoamiAs(role: string) {
  server.use(
    http.get("*/api/whoami", () =>
      HttpResponse.json({
        ok: true,
        project_id: "test-project",
        principal_id: `principal-${role}`,
        token_name: "test-user",
        role,
      }),
    ),
  );
}
