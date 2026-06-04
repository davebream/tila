import { Hono } from "hono";
import { createAdminRoutes } from "./routes/admin-routes";
import { createArtifactRoutes } from "./routes/artifact-routes";
import { createCoordinationRoutes } from "./routes/coordination-routes";
import { createDiagnosticRoutes } from "./routes/diagnostic-routes";
import { createEntityRoutes } from "./routes/entity-routes";
import { installProjectErrorHandlers } from "./routes/errors";
import { createGateRoutes } from "./routes/gate-routes";
import { createJournalArchiveRoutes } from "./routes/journal-archive-routes";
import { createRecordRoutes } from "./routes/record-routes";
import { createSchemaRoutes } from "./routes/schema-routes";
import { createSignalRoutes } from "./routes/signal-routes";
import { createSweepRoutes } from "./routes/sweep-routes";
import type { RouterDeps } from "./routes/types";

export type { RouterDeps } from "./routes/types";

export function createProjectRouter(deps: RouterDeps) {
  const app = new Hono();

  installProjectErrorHandlers(app);

  app.route("/", createAdminRoutes(deps));
  app.route("/", createEntityRoutes(deps));
  app.route("/", createArtifactRoutes(deps));
  app.route("/", createCoordinationRoutes(deps));
  app.route("/", createGateRoutes(deps));
  app.route("/", createSignalRoutes(deps));
  app.route("/", createSchemaRoutes(deps));
  app.route("/", createSweepRoutes(deps));
  app.route("/", createRecordRoutes(deps));
  app.route("/", createJournalArchiveRoutes(deps));
  app.route("/", createDiagnosticRoutes(deps));

  return app;
}
