import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { MIGRATIONS, MIGRATION_BOOTSTRAP } from "@tila/ops-sqlite";
import { expect, it } from "vitest";
import { runProjectMigrations } from "../../backend-do/src/migration-runner";
import { bindings } from "./setup";

import { identity, post } from "./helpers";

it("serializes exclusive claims, advances fences and rejects stale destructive writes", async () => {
  const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
  const create = await post(stub, "/entity/create", {
    id: "task-1",
    type: "task",
    data: { title: "original" },
    created_by: identity.principal_id,
  });
  expect(create.status, await create.text()).toBe(200);
  const claim = { resource: "task:task-1", mode: "exclusive", ttl_ms: 60_000 };
  const contenders = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      post(stub, "/coord/acquire", {
        ...claim,
        participant_id: `worker-${index}`,
      }),
    ),
  );
  expect(contenders.filter((response) => response.status === 200)).toHaveLength(
    1,
  );
  expect(contenders.filter((response) => response.status === 409)).toHaveLength(
    5,
  );
  const winnerResponse = contenders.find((response) => response.status === 200);
  if (!winnerResponse) throw new Error("No claim winner");
  const winner = await winnerResponse.json<{
    fence: number;
    participant_id: string;
  }>();
  expect(
    (await post(stub, "/coord/release", { ...claim, ...winner })).status,
  ).toBe(200);
  const next = await (await post(stub, "/coord/acquire", claim)).json<{
    fence: number;
  }>();
  expect(next.fence).toBeGreaterThan(winner.fence);
  const stale = await post(stub, "/entity/archive/task-1", {
    fence: winner.fence,
  });
  expect(stale.status).toBe(409);
  const entity = await (
    await stub.fetch("https://project/entity/get/task-1")
  ).json<{ entity: { archived: number; data: { title: string } } }>();
  expect(entity.entity.archived).toBe(0);
  expect(entity.entity.data.title).toBe("original");
  await evictDurableObject(stub);
  const restored = await bindings.PROJECT.get(stub.id).fetch(
    "https://project/entity/get/task-1",
  );
  expect(await restored.json()).toEqual(entity);
  const state = await (
    await bindings.PROJECT.get(stub.id).fetch(
      "https://project/coord/state?resource=task:task-1",
    )
  ).json<{ claim: { fence: number } }>();
  expect(state.claim.fence).toBe(next.fence);
});

it("upgrades a seeded old DO schema with real migrations and rolls back failed transactions", async () => {
  const stub = bindings.MIGRATION.get(bindings.MIGRATION.newUniqueId());
  await runInDurableObject(stub, (_instance, state) => {
    const storage = state.storage;
    storage.sql.exec(MIGRATION_BOOTSTRAP);
    for (const migration of MIGRATIONS.filter(
      (migration) => migration.version <= 3,
    )) {
      if ("sql" in migration) storage.sql.exec(migration.sql);
      else migration.run(storage);
      storage.sql.exec(
        "INSERT INTO _migrations VALUES (?, ?)",
        migration.version,
        1,
      );
    }
    storage.sql.exec(
      "INSERT INTO entities VALUES ('seed', 'task', 1, '{\"title\":\"preserved\"}', 0, 1, 1, 'seed-author')",
    );
    runProjectMigrations(storage);
    expect(
      storage.sql
        .exec("SELECT version FROM _migrations ORDER BY version")
        .toArray(),
    ).toEqual(MIGRATIONS.map(({ version }) => ({ version })));
    expect(
      storage.sql.exec("SELECT data FROM entities WHERE id = 'seed'").one()
        .data,
    ).toBe('{"title":"preserved"}');
    expect(() =>
      storage.transactionSync(() => {
        storage.sql.exec("UPDATE entities SET data = '{}' WHERE id = 'seed'");
        storage.sql.exec("INSERT INTO entities (id) VALUES ('seed')");
      }),
    ).toThrow();
    expect(
      storage.sql.exec("SELECT data FROM entities WHERE id = 'seed'").one()
        .data,
    ).toBe('{"title":"preserved"}');
    runProjectMigrations(storage);
    expect(
      storage.sql.exec("SELECT count(*) AS n FROM _migrations").one().n,
    ).toBe(MIGRATIONS.length);
  });
});
