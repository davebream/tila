import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseSchemaToml } from "@tila/core";
import {
  scaleCreates,
  scaleExpectedIds,
} from "../packages/integration-tests/fixtures/s1-scale.ts";

// Reuses the caller's sole browser, local project, credential boundary and cleanup.
export async function runS1Scale({
  page,
  request,
  api,
  ui,
  project,
  bounded,
  record,
  evidence,
}) {
  const base = `/projects/${project}`;
  const listQuery = "sort=id&order=asc&archived=0&limit=100";
  const searchQuery = "kind=task&syntax=literal&limit=100&q=";
  const manifests = [];
  let phaseStarted = performance.now();
  function phase(name, details = {}) {
    record(name, {
      phase_duration_ms: performance.now() - phaseStarted,
      ...details,
    });
    phaseStarted = performance.now();
  }
  async function save() {
    await writeFile(
      resolve(evidence, "scale-pages.json"),
      JSON.stringify(manifests, null, 2),
      { mode: 0o600 },
    );
  }
  function listPage(data, index) {
    const ids = data.entities.map((e) => e.id);
    assert.deepEqual(
      ids,
      scaleExpectedIds.slice(index * 100, (index + 1) * 100),
    );
    assert.equal(data.total, 301);
    assert.equal(data.limit, 100);
    assert.equal(data.has_more, index < 3);
    assert.equal(data.scope.restricted, false);
    assert.equal(data.scope.archived, "excluded");
    if (index < 3)
      assert.ok(
        typeof data.next_cursor === "string" && data.next_cursor.length > 0,
      );
    else assert.equal(data.next_cursor, null);
    return ids;
  }
  function searchPage(data, expected, more) {
    assert.ok(data.results.every((r) => r.type === "entity"));
    const ids = data.results.map((r) => r.entity_id);
    assert.deepEqual(ids, expected);
    assert.equal(
      data.total,
      expected.length,
      "search total is this page's length",
    );
    assert.deepEqual(data.scope.kinds, ["task"]);
    assert.equal(data.scope.restricted, false);
    assert.equal(data.scope.archived, "excluded");
    if (more)
      assert.ok(
        typeof data.next_cursor === "string" && data.next_cursor.length > 0,
      );
    else assert.equal(data.next_cursor, null);
    return ids;
  }
  async function apiPages(label) {
    let cursor = null;
    const entities = [];
    for (let i = 0; i < 4; i++) {
      const data = await request(
        `${base}/tasks?${listQuery}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      manifests.push({
        phase: label,
        page: i + 1,
        ids: listPage(data, i),
        total: data.total,
        has_more: data.has_more,
      });
      entities.push(...data.entities);
      cursor = data.next_cursor;
    }
    assert.equal(new Set(entities.map((e) => e.id)).size, 301);
    assert.deepEqual(
      entities.map(({ id, type, data }) => ({ id, type, data })),
      scaleExpectedIds.map((id, i) => ({
        id,
        type: "task",
        data: {
          title: `s1scalecommon ${i === 300 ? "s1scalesentinel" : `s1scalerow${String(i + 1).padStart(3, "0")}`}`,
        },
      })),
    );
    await save();
  }
  async function catalog() {
    const data = await request(`${base}/tasks/~/types`);
    assert.deepEqual(
      data.types.map(({ type, declaration, count, archived_count }) => ({
        type,
        declaration,
        count,
        archived_count,
      })),
      [
        { type: "bug", declaration: "declared", count: 0, archived_count: 0 },
        {
          type: "task",
          declaration: "declared",
          count: 301,
          archived_count: 0,
        },
      ],
    );
  }
  const schema = await request(`${base}/schema`);
  const history = await request(`${base}/schema/history`);
  const parsed = parseSchemaToml(schema.schema.definition);
  assert.equal(parsed.ok, true);
  assert.deepEqual(Object.keys(parsed.schema.work_units).sort(), [
    "bug",
    "task",
  ]);
  assert.deepEqual(parsed.schema.work_units.task.fields, {
    title: { name: "title", type: "string", required: true },
  });
  assert.deepEqual(parsed.schema.work_units.bug.fields, {});
  const initial = await request(`${base}/tasks?${listQuery}`);
  assert.deepEqual(initial.entities, []);
  assert.equal(initial.total, 0);
  await bounded(
    (async () => {
      for (const task of scaleCreates) {
        const created = await request(`${base}/tasks`, task);
        assert.equal(created.entity.id, task.id);
        assert.equal(created.entity.type, task.type);
        assert.deepEqual(created.entity.data, task.data);
      }
    })(),
    90_000,
    "301 acknowledged public task creates",
  );
  const manifest = JSON.stringify({
    expected_ids: scaleExpectedIds,
    creates: scaleCreates,
  });
  await writeFile(resolve(evidence, "scale-corpus.json"), manifest, {
    mode: 0o600,
    flag: "wx",
  });
  phase("301 task corpus acknowledged and frozen", {
    count: 301,
    corpus_sha256: createHash("sha256").update(manifest).digest("hex"),
    schema_revision: schema.revision,
  });

  try {
    await bounded(
      (async () => {
        await apiPages("api-list");
        let cursor = null;
        const found = [];
        for (let i = 0; i < 4; i++) {
          const data = await request(
            `${base}/search?${searchQuery}s1scalecommon${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          );
          const ids = searchPage(
            data,
            scaleExpectedIds.slice(i * 100, (i + 1) * 100),
            i < 3,
          );
          manifests.push({
            phase: "api-search",
            page: i + 1,
            ids,
            total: data.total,
          });
          found.push(...ids);
          cursor = data.next_cursor;
        }
        assert.deepEqual(found, scaleExpectedIds);
        for (const q of ["s1scalesentinel", "s1-scale-301", "s1scaleabsent"]) {
          const expected = q === "s1scaleabsent" ? [] : ["s1-scale-301"];
          searchPage(
            await request(`${base}/search?${searchQuery}${q}`),
            expected,
            false,
          );
        }
        await catalog();
        phase("exact API list and search pages beyond 250");

        const tasksUrl = `${ui}/p/${project}/tasks`;
        const nav = () =>
          page.getByRole("navigation", { name: "Task pages", exact: true });
        const input = page.getByRole("searchbox", {
          name: "Search tasks",
          exact: true,
        });
        async function dom(expected, q = "", after = null, type = "") {
          await page.waitForURL(
            (url) =>
              url.pathname === `/p/${project}/tasks` &&
              (url.searchParams.get("q") ?? "") === q &&
              (url.searchParams.get("after") ?? null) === after &&
              (url.searchParams.get("type") ?? "") === type,
          );
          await page.waitForFunction(
            ({ expected }) => {
              const actual = Array.from(
                document.querySelectorAll("tbody a"),
              ).map((a) => a.textContent.trim());
              return JSON.stringify(actual) === JSON.stringify(expected);
            },
            { expected },
            { timeout: 10_000 },
          );
          const actual = await page.locator("tbody a").allTextContents();
          assert.deepEqual(actual, expected);
          manifests.push({ phase: "browser-dom", q, type, ids: actual });
          await save();
        }
        async function response(path, params, action) {
          const [res] = await Promise.all([
            page.waitForResponse(
              (res) => {
                const url = new URL(res.url());
                return (
                  url.origin === api &&
                  url.pathname === `${base}${path}` &&
                  res.request().method() === "GET" &&
                  Object.entries(params).every(
                    ([key, value]) =>
                      (url.searchParams.get(key) ?? null) === value,
                  )
                );
              },
              { timeout: 10_000 },
            ),
            action(),
          ]);
          assert.equal(res.status(), 200);
          const data = await res.json();
          assert.equal(data.ok, true);
          return data;
        }
        const first = await response(
          "/tasks",
          {
            sort: "id",
            order: "asc",
            archived: "0",
            limit: "100",
            cursor: null,
          },
          () => page.goto(`${tasksUrl}?sort=id:asc`),
        );
        const cursors = [null];
        const listIds = [];
        let listData = first;
        for (let i = 0; i < 4; i++) {
          const ids = listPage(listData, i);
          await dom(ids, "", cursors[i]);
          await page
            .getByText("301 tasks · excluding archived", { exact: true })
            .waitFor();
          listIds.push(...ids);
          manifests.push({
            phase: "browser-list-response",
            page: i + 1,
            ids,
            total: listData.total,
            has_more: listData.has_more,
          });
          if (i < 3) {
            cursors.push(listData.next_cursor);
            listData = await response(
              "/tasks",
              {
                cursor: listData.next_cursor,
                sort: "id",
                order: "asc",
                archived: "0",
                limit: "100",
              },
              () =>
                nav()
                  .getByRole("button", { name: "Next", exact: true })
                  .click(),
            );
          }
        }
        assert.deepEqual(listIds, scaleExpectedIds);
        assert.equal(new Set(listIds).size, 301);
        assert.equal(
          await nav()
            .getByRole("button", { name: "Next", exact: true })
            .count(),
          0,
        );
        await page.screenshot({
          path: resolve(evidence, "scale-list-page4.png"),
          fullPage: true,
        });
        await nav()
          .getByRole("button", { name: "Previous", exact: true })
          .click();
        await dom(scaleExpectedIds.slice(200, 300), "", cursors[2]);
        await nav().getByRole("button", { name: "Next", exact: true }).click();
        await dom(["s1-scale-301"], "", cursors[3]);
        // A new literal request proves this is server search, even from list page four.
        async function query(q, expected) {
          const data = await response(
            "/search",
            { q, kind: "task", syntax: "literal", limit: "100", cursor: null },
            () => input.fill(q),
          );
          searchPage(data, expected, false);
          await dom(expected, q);
          await page
            .getByText(
              `${expected.length} ${expected.length === 1 ? "result" : "results"} · ranked by relevance · non-archived tasks`,
              { exact: true },
            )
            .waitFor();
        }
        await query("s1scalesentinel", ["s1-scale-301"]);
        await page.screenshot({
          path: resolve(evidence, "scale-sentinel-search.png"),
          fullPage: true,
        });
        await query("s1-scale-301", ["s1-scale-301"]);
        await query("s1scaleabsent", []);
        await page
          .getByText("No tasks match “s1scaleabsent”.", { exact: true })
          .waitFor();
        phase("browser list pages, previous and sentinel search reset");

        let searchData = await response(
          "/search",
          {
            q: "s1scalecommon",
            kind: "task",
            syntax: "literal",
            limit: "100",
            cursor: null,
          },
          () => input.fill("s1scalecommon"),
        );
        const searchIds = [];
        let after = null;
        for (let i = 0; i < 4; i++) {
          const ids = searchPage(
            searchData,
            scaleExpectedIds.slice(i * 100, (i + 1) * 100),
            i < 3,
          );
          await dom(ids, "s1scalecommon", after);
          searchIds.push(...ids);
          manifests.push({
            phase: "browser-search-response",
            page: i + 1,
            ids,
            total: searchData.total,
          });
          await page
            .getByText(
              `${ids.length} ${ids.length === 1 ? "result" : "results"} · ranked by relevance · non-archived tasks`,
              { exact: true },
            )
            .waitFor();
          if (i < 3) {
            after = searchData.next_cursor;
            searchData = await response(
              "/search",
              {
                q: "s1scalecommon",
                kind: "task",
                syntax: "literal",
                limit: "100",
                cursor: after,
              },
              () =>
                nav()
                  .getByRole("button", { name: "More results", exact: true })
                  .click(),
            );
          }
        }
        assert.deepEqual(searchIds, scaleExpectedIds);
        assert.equal(new Set(searchIds).size, 301);
        assert.equal(
          await nav()
            .getByRole("button", { name: "More results", exact: true })
            .count(),
          0,
        );

        // The type catalog is independent of the final one-row result page.
        await page.getByRole("button", { name: "Type", exact: true }).click();
        const bugCount = page
          .getByText("bug", { exact: true })
          .locator("..")
          .getByText("0", { exact: true });
        await bugCount.waitFor();
        const empty = await response(
          "/search",
          {
            q: "s1scalecommon",
            type: "bug",
            cursor: null,
            kind: "task",
            syntax: "literal",
          },
          () => bugCount.click(),
        );
        searchPage(empty, [], false);
        await dom([], "s1scalecommon", null, "bug");
        await page.keyboard.press("Escape");
        const emptyList = await response(
          "/tasks",
          {
            type: "bug",
            cursor: null,
            sort: "id",
            order: "asc",
            archived: "0",
            limit: "100",
          },
          () => input.fill(""),
        );
        assert.deepEqual(emptyList.entities, []);
        assert.equal(emptyList.total, 0);
        assert.equal(emptyList.has_more, false);
        assert.equal(emptyList.next_cursor, null);
        await dom([], "", null, "bug");
        await page
          .getByText("No tasks match these filters.", { exact: true })
          .waitFor();
        await page
          .getByRole("button", { name: "Type: 1", exact: true })
          .click();
        await page.getByRole("button", { name: "Clear", exact: true }).click();
        await page.keyboard.press("Escape");
        await dom(scaleExpectedIds.slice(0, 100));
        await page
          .getByText("301 tasks · excluding archived", { exact: true })
          .waitFor();
        assert.equal(
          await nav()
            .getByRole("button", { name: "Previous", exact: true })
            .count(),
          0,
        );
        await catalog();
        await apiPages("final-api-list");
        assert.deepEqual(await request(`${base}/schema`), schema);
        assert.deepEqual(await request(`${base}/schema/history`), history);
        await page.screenshot({
          path: resolve(evidence, "scale-restored-page1.png"),
          fullPage: true,
        });
        phase(
          "browser common search pages and empty declared type retain schema history",
        );
      })(),
      90_000,
      "301 task API and browser assertions",
    );
  } finally {
    await save();
  }
}
