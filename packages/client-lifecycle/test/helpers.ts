import { join } from "node:path";
import type { LifecycleState } from "@tila/schemas";
import {
  type TilaLocal,
  buildLocalResources,
  createTilaLocal,
} from "tila-sdk/local";
import { Lifecycle, SessionStore } from "../src/index";

export function harness(root: string) {
  const connections: TilaLocal[] = [];
  const store = new SessionStore(join(root, "sessions"));
  const facade = async (state: LifecycleState) => {
    const local = await createTilaLocal({
      dbPath: join(root, "project.db"),
      artifactsPath: join(root, "artifacts"),
      project: "test",
      skipFilesystemCheck: true,
      identity: {
        principal_id: "local:test",
        participant_id: state.participantId,
        environment: state.environment,
      },
    });
    connections.push(local);
    return buildLocalResources(local.project, local.artifacts);
  };
  return {
    store,
    facade,
    lifecycle: new Lifecycle(store, "test", facade),
    close: () => {
      for (const connection of connections) connection.close();
    },
  };
}
