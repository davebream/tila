import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLocalResources, createTilaLocal } from "tila-sdk/local";
import {
  queueConformance,
  queueConformanceDefinition,
} from "./queue-conformance";

queueConformance("embedded SDK queue conformance", async () => {
  const root = await mkdtemp(join(tmpdir(), "tila-conformance-"));
  const local = await createTilaLocal({
    dbPath: join(root, "db"),
    artifactsPath: join(root, "blobs"),
    project: "conformance",
    identity: {
      principal_id: "worker",
      participant_id: "worker",
      environment: {},
    },
  });
  const resources = buildLocalResources(local.project, local.artifacts);
  await resources.schema.apply(queueConformanceDefinition, undefined, {
    expected_revision: 0,
  });
  return {
    queue: resources.queue,
    attempts: resources.attempts,
    createTask: (id) => resources.tasks.create(id, "issue", { phase: "todo" }),
    close: async () => {
      local.close();
      await rm(root, { recursive: true, force: true });
    },
  };
});
