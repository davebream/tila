import { runInDurableObject } from "cloudflare:test";
import { schema } from "@tila/ops-sqlite";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { it } from "vitest";
import { recoveryScenarios } from "../../ops-sqlite/test/recovery-scenarios";
import { bindings } from "./setup";
for (const scenario of recoveryScenarios)
  it(scenario.name, async () => {
    const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
    await runInDurableObject(stub, (_instance, state) => {
      scenario.run(drizzle(state.storage, { schema }));
    });
  });
