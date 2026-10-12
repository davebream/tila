import { expect } from "vitest";
import {
  queueConformance,
  queueConformanceDefinition,
} from "../src/queue-conformance";
import { queueApiFixture } from "./queue-api-fixture";

queueConformance("authenticated Worker queue conformance", async () => {
  const f = await queueApiFixture(queueConformanceDefinition);
  return {
    ...f,
    createTask: async (id) => {
      const response = await f.http("/tasks", {
        id,
        type: "issue",
        data: { phase: "todo" },
      });
      expect(response.status, await response.clone().text()).toBe(200);
    },
    close: async () => {},
  };
});
