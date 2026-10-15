import { customJournalOps, reportSearchOps, schema } from "@tila/ops-sqlite";
import { expect, it } from "vitest";
import { createEntityRoutes } from "../../src/do/routes/entity-routes";
import type { RouterDeps } from "../../src/do/routes/types";
import { createTestDb } from "./helpers/create-test-db";

it("reads results and coverage together if indexing finishes while scheduling yields", async () => {
  const f = createTestDb();
  try {
    await customJournalOps.appendReport(f.db, {
      projectId: "p",
      origin: {
        principalId: "p",
        participantId: "session",
        actor: "p",
        environment: {},
      },
      input: {
        event_name: "pipeline.tested",
        event_version: 1,
        target: { kind: "project" },
        data: { text: "raceneedle" },
      },
      idempotencyKey: "one",
      authorizedRole: "participant",
    });
    f.db.delete(schema.reportSearchDocs).run();
    const deps: RouterDeps = {
      db: f.db as RouterDeps["db"],
      enrichOpts: () => ({}),
      ctx: {
        storage: {
          sql: {
            exec: (statement: string, ...bindings: unknown[]) => ({
              toArray: () => f.sqlite.prepare(statement).all(...bindings),
            }),
          },
          get: async () => {
            await reportSearchOps.indexReportHistoryBatch(f.db);
            return undefined;
          },
          put: async () => {},
          getAlarm: async () => null,
          setAlarm: async () => {},
        },
      } as unknown as DurableObjectState,
    };
    const response = await createEntityRoutes(deps).request(
      "/search?q=raceneedle&kind=report&project_id=p",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      results: unknown[];
      scope: { report_history: { status: string } };
    };
    expect(body.scope.report_history.status).toBe("complete");
    expect(body.results).toMatchObject([{ type: "report", seq: 1 }]);
  } finally {
    f.sqlite.close();
  }
});
