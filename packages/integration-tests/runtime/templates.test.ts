import { evictDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { post } from "./helpers";
import { bindings } from "./setup";

const definition = `schema_version = 1
[work_units.bug.fields.title]
type = "string"
required = true

[templates.hotfix]
description = "A bug for a regression"
[templates.hotfix.entities.root]
type = "bug"
id_suffix = ""
[templates.hotfix.entities.root.data]
title = "Fix {{area}}"
`;

it("lists template variables and reports a retried instantiation as already existing", async () => {
  const stub = bindings.PROJECT.get(bindings.PROJECT.newUniqueId());
  expect(
    (
      await post(stub, "/schema/apply", {
        definition,
        applied_by: "runtime",
        expected_revision: 0,
      })
    ).status,
  ).toBe(200);

  const list = await (await stub.fetch("https://project/template/list")).json<{
    templates: Array<{ name: string; variables: string[] }>;
  }>();
  expect(list.templates).toMatchObject([
    {
      name: "hotfix",
      variables: ["area"],
      entities: [{ key: "root", type: "bug", id_suffix: "" }],
    },
  ]);

  const request = {
    template_name: "hotfix",
    root_id: "HF-1",
    vars: { area: "login" },
  };
  expect((await post(stub, "/template/instantiate", request)).status).toBe(200);
  await evictDurableObject(stub);
  const retry = await post(
    bindings.PROJECT.get(stub.id),
    "/template/instantiate",
    request,
  );
  expect(retry.status).toBe(409);
  expect(await retry.json()).toMatchObject({
    error: { code: "already-exists" },
  });

  const search = await (
    await stub.fetch("https://project/entity/search?q=login")
  ).json<{ results: Array<{ entity_id: string }> }>();
  expect(search.results.map((r) => r.entity_id)).toEqual(["HF-1"]);
});
