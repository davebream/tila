import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Browser-injected failures over real local state; never backend outage/auth evidence.
export async function runClaimsOutage({
  page,
  request: helperRequest,
  api,
  ui,
  project,
  bounded,
  record,
  evidence,
  signal,
  stopBrowserWork,
  openPage,
}) {
  const started = performance.now();
  let phaseStarted = started;
  let step = "freeze claims subject";
  const journal = [];
  const events = [];
  const violations = [];
  const cleanup = {
    route_removed: false,
    listeners_removed: false,
    claim_absent: false,
    claim_absence_check: "not-checked",
    browser_work_stopped: false,
    errors: [],
  };
  const controller = new AbortController();
  const cancel = (reason) => {
    failed = true;
    controller.abort(reason);
  };
  const abort = () => cancel(new Error("Claims stage cancelled"));
  const base = `/projects/${project}`;
  let manifest;
  let sentinel;
  let resource;
  let selectedUrl;
  let statePath;
  let dialog;
  let region;
  let fields;
  let table;
  let disclosure;
  let mode = "held";
  let releaseGate;
  const gate = new Promise((done) => {
    releaseGate = done;
  });
  controller.signal.addEventListener("abort", () => releaseGate(), {
    once: true,
  });
  let held;
  const firstHeld = new Promise((done) => {
    held = done;
  });
  const pending = new Map();
  const classified = new Map();
  const requests = new Map();
  const operations = new Set();
  const routes = new Set();
  let requestSequence = 0;
  let generation = 0;
  let failed = true;
  let fence = null;
  let claim = null;
  let acquisition = null;
  let routeInstalled = false;
  let identity;
  let baseline;
  let drawerNode;
  let fieldsNode;
  let dataNode;
  let nativeStop;
  function stopNative() {
    nativeStop ??= Promise.resolve()
      .then(() => stopBrowserWork())
      .then(() => {
        cleanup.browser_work_stopped = true;
      })
      .catch(() => {
        cleanup.errors.push("browser work cancellation failed");
      });
    return nativeStop;
  }
  controller.signal.addEventListener("abort", () => {
    if (failed) void stopNative();
  });
  function check() {
    controller.signal.throwIfAborted();
  }
  // Track underlying work through settlement, even if a Promise.all sibling fails.
  // Helper/file operations use abort signals. Native Playwright work additionally
  // needs connection disposal: evaluate/count/route/body reads have no timeout.
  async function operation(action) {
    check();
    const pending = Promise.resolve(action());
    operations.add(pending);
    try {
      const result = await pending;
      check();
      return result;
    } finally {
      operations.delete(pending);
    }
  }
  async function browser(action) {
    const timer = setTimeout(
      () => cancel(new Error("Claims native operation exceeded 15 seconds")),
      15_000,
    );
    try {
      // The deadline stops the actual connection/process; keep awaiting the raw
      // operation until that disposal rejects it. Never race it out of tracking.
      return await operation(action);
    } finally {
      clearTimeout(timer);
    }
  }
  // These waits only observe our gate/network bookkeeping; cancellation removes
  // their timer/listener. They never initiate browser or helper work.
  const wait = (action, label) =>
    operation(async () => {
      let timer;
      let cancelled;
      try {
        return await new Promise((resolve, reject) => {
          cancelled = () => reject(controller.signal.reason);
          timer = setTimeout(
            () => reject(new Error(`${label} timed out`)),
            15_000,
          );
          controller.signal.addEventListener("abort", cancelled, {
            once: true,
          });
          check();
          Promise.resolve()
            .then(() => {
              check();
              return action();
            })
            .then(resolve, reject);
        });
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", cancelled);
      }
    });
  async function request(path, body) {
    check();
    return operation(() =>
      helperRequest(
        path,
        body,
        AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      ),
    );
  }
  const matches = (url) =>
    url.origin === api && url.pathname === `${base}/claims`;
  const isClaims = (req) =>
    req.method() === "GET" && matches(new URL(req.url()));
  const onRequest = (req) => {
    const url = new URL(req.url());
    if (
      url.origin !== api ||
      !(url.pathname === base || url.pathname.startsWith(`${base}/`))
    )
      return;
    const metadata = {
      request_id: ++requestSequence,
      generation,
      phase: step,
      method: req.method(),
      pathname: url.pathname,
      mode,
    };
    requests.set(req, metadata);
    let done;
    const settled = new Promise((resolve) => {
      done = resolve;
    });
    pending.set(req, { settled, done });
    if (
      url.pathname === `${base}/schema` ||
      url.pathname.startsWith(`${base}/schema/`)
    )
      violations.push({ ...metadata, reason: "browser schema read on Tasks" });
    if (!["GET", "OPTIONS"].includes(req.method()))
      violations.push({ ...metadata, reason: "unexpected browser mutation" });
    if (url.pathname === `${base}/tasks/~/types` && req.method() === "GET")
      events.push({
        ...metadata,
        kind: "catalog-request",
        at_ms: performance.now() - started,
      });
    if (isClaims(req))
      events.push({
        ...metadata,
        kind: "claims-request",
        at_ms: performance.now() - started,
      });
  };
  function observed(req) {
    const url = new URL(req.url());
    if (
      url.origin !== api ||
      !(url.pathname === base || url.pathname.startsWith(`${base}/`))
    )
      return null;
    return (
      requests.get(req) || {
        request_id: null,
        generation: null,
        phase: "request began before stage observation",
        method: req.method(),
        pathname: url.pathname,
      }
    );
  }
  const onResponse = (res) => {
    const req = res.request();
    const metadata = observed(req);
    if (!metadata) return;
    const classification = classified.get(req) || "real-local-worker";
    const status = res.status();
    const event = {
      ...metadata,
      classification,
      status,
      kind: isClaims(req)
        ? "claims-response"
        : metadata.pathname === `${base}/tasks/~/types`
          ? "catalog-response"
          : "project-response",
      at_ms: performance.now() - started,
    };
    events.push(event);
    const synthetic =
      isClaims(req) &&
      ((classification === "synthetic-503" && status === 503) ||
        (classification === "synthetic-403" && status === 403));
    if (
      !synthetic &&
      !(classification === "real-local-worker" && status >= 200 && status < 300)
    )
      violations.push({ ...event, reason: "unexpected project HTTP response" });
  };
  const onFinished = (req) => {
    pending.get(req)?.done();
    pending.delete(req);
  };
  const onFailed = (req) => {
    const metadata = observed(req);
    if (metadata) {
      const event = {
        ...metadata,
        kind: "project-transport-failure",
        classification: classified.get(req) || "real-local-worker",
        cancelled: failed && controller.signal.aborted,
        at_ms: performance.now() - started,
      };
      events.push(event);
      // Cancellation can only explain a failure when this stage is already failing.
      if (!event.cancelled)
        violations.push({ ...event, reason: "project transport failure" });
    }
    onFinished(req);
  };
  const handleRoute = async (route) => {
    if (!isClaims(route.request())) return browser(() => route.fallback());
    if (mode === "held") {
      held();
      await gate;
    }
    if (controller.signal.aborted) return;
    const selected = mode;
    classified.set(
      route.request(),
      selected === "real" ? "real-local-worker" : `synthetic-${selected}`,
    );
    if (selected === "real") return browser(() => route.fallback());
    assert.ok(selected === "503" || selected === "403");
    return browser(() =>
      route.fulfill({
        status: Number(selected),
        contentType: "application/json",
        headers: {
          "Access-Control-Allow-Origin": ui,
          "Access-Control-Allow-Credentials": "true",
          Vary: "Origin",
        },
        body: JSON.stringify({
          ok: false,
          error: {
            code: selected === "503" ? "do-unreachable" : "permission-denied",
            message:
              selected === "503"
                ? "Injected local outage"
                : "Injected local withdrawal",
            retryable: selected === "503",
          },
        }),
      }),
    );
  };
  const handler = (route) => {
    const active = handleRoute(route);
    routes.add(active);
    active.finally(() => routes.delete(active)).catch(() => {});
    return active;
  };
  async function transition(next) {
    await wait(
      () => Promise.all([...pending.values()].map(({ settled }) => settled)),
      "settle previous claims reads",
    );
    check();
    mode = next;
    generation++;
  }
  async function response(status, action = () => {}, afterRequest = 0) {
    check();
    const [res] = await Promise.all([
      browser(() =>
        page.waitForResponse(
          (res) =>
            isClaims(res.request()) &&
            res.status() === status &&
            requests.get(res.request())?.request_id > afterRequest,
          { timeout: 15_000 },
        ),
      ),
      browser(action),
    ]);
    // A response event only guarantees headers. Wait for delivery using a native
    // finite Playwright event wait before accessing finished()/JSON.
    if (pending.has(res.request())) {
      await browser(() =>
        page.waitForEvent("requestfinished", {
          predicate: (req) => req === res.request(),
          timeout: 15_000,
        }),
      );
    }
    assert.equal(await browser(() => res.finished()), null);
    assert.equal(
      classified.get(res.request()),
      status === 200 ? "real-local-worker" : `synthetic-${status}`,
    );
    if (status === 200) {
      const body = await browser(() => res.json());
      assert.equal(body.ok, true);
      assert.deepEqual(
        body.claims.filter(
          (c) => c.resource === resource || c.resource === sentinel.id,
        ),
        claim ? [claim] : [],
      );
    }
    return res;
  }
  async function corpus() {
    const entities = [];
    let cursor;
    for (let i = 0; i < 4; i++) {
      check();
      const data = await request(
        `${base}/tasks?sort=id&order=asc&archived=0&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      assert.equal(data.total, 301);
      assert.equal(data.has_more, i < 3);
      entities.push(...data.entities);
      cursor = data.next_cursor;
    }
    assert.deepEqual(
      entities.map(({ id }) => id),
      manifest.expected_ids,
    );
    return entities;
  }
  async function snapshot() {
    check();
    const [task, schema, history, catalog, entities] = await Promise.all([
      request(`${base}/tasks/${sentinel.id}`),
      request(`${base}/schema`),
      request(`${base}/schema/history`),
      request(`${base}/tasks/~/types`),
      corpus(),
    ]);
    return { task, schema, history, catalog, entities };
  }
  async function oracle(name) {
    check();
    assert.deepEqual(
      await snapshot(),
      baseline,
      "task, corpus, catalog and schema/history remain unchanged",
    );
    const [list, state] = await Promise.all([
      request(`${base}/claims`),
      request(statePath),
    ]);
    const matching = list.claims.filter(
      (c) => c.resource === resource || c.resource === sentinel.id,
    );
    assert.deepEqual(matching, claim ? [claim] : []);
    assert.deepEqual(state.claim, claim);
    if (claim) {
      assert.equal(claim.fence, fence);
      assert.equal(claim.resource, resource);
      assert.equal(claim.principal_id, identity.principal_id);
      assert.equal(claim.participant_id, "browser-competitor");
      assert.equal(claim.mode, "exclusive");
      assert.ok(claim.expires_at > Date.now());
    }
    assert.equal(page.url(), selectedUrl);
    await browser(() => dialog.waitFor());
    await browser(() =>
      dialog.getByText(sentinel.id, { exact: true }).waitFor(),
    );
    await browser(() =>
      fields.getByRole("table", { name: "Task fields", exact: true }).waitFor(),
    );
    await browser(() =>
      fields.getByText(sentinel.data.title, { exact: true }).waitFor(),
    );
    assert.equal(
      await browser(() =>
        dialog.getByRole("button", { name: "Collapse", exact: true }).count(),
      ),
      1,
    );
    assert.equal(
      await browser(() => disclosure.getAttribute("aria-expanded")),
      "true",
    );
    assert.deepEqual(
      JSON.parse(
        await browser(() =>
          dialog
            .getByRole("region", { name: "Technical details", exact: true })
            .locator("pre")
            .textContent(),
        ),
      ),
      sentinel.data,
    );
    assert.equal(
      await browser(() =>
        drawerNode.evaluate(
          (node) => node === document.querySelector('[role="dialog"]'),
        ),
      ),
      true,
    );
    assert.equal(
      await browser(() => fieldsNode.evaluate((node) => node.isConnected)),
      true,
    );
    assert.equal(
      await browser(() => dataNode.evaluate((node) => node.isConnected)),
      true,
    );
    assert.deepEqual(violations, []);
    const entry = {
      phase: name,
      duration_ms: performance.now() - phaseStarted,
      elapsed_ms: performance.now() - started,
      backend: {
        invariant_sha256: createHash("sha256")
          .update(JSON.stringify(baseline))
          .digest("hex"),
        claim,
        task_schema_catalog_corpus_unchanged: true,
        list_and_state_agree: true,
      },
      dom: {
        claim_state: await browser(() => region.innerText()),
        stale_timestamp: (await browser(() => region.locator("time").count()))
          ? await browser(() => region.locator("time").getAttribute("datetime"))
          : null,
        drawer_name: sentinel.data.title,
        selected_url:
          new URL(selectedUrl).pathname + new URL(selectedUrl).search,
        drawer_fields_and_disclosure_retained: true,
      },
      browser_responses: events.filter(({ kind }) => kind === "claims-response")
        .length,
    };
    check();
    journal.push(entry);
    await operation(() => save(controller.signal));
    check();
    record(`claims ${name}`, entry);
    phaseStarted = performance.now();
  }
  async function absent() {
    await browser(() =>
      region.getByText("Not claimed.", { exact: true }).waitFor(),
    );
    assert.equal(await browser(() => table.count()), 0);
    assert.equal(
      await browser(() => region.getByText(/^Last known:/).count()),
      0,
    );
    assert.equal(await browser(() => region.locator("time").count()), 0);
    assert.equal(
      await browser(() =>
        region.getByRole("button", { name: "Retry", exact: true }).count(),
      ),
      0,
    );
    assert.equal(
      await browser(() =>
        region
          .getByText("You do not have access to claim state.", { exact: true })
          .count(),
      ),
      0,
    );
  }
  async function populated() {
    await browser(() => table.waitFor());
    for (const [label, value] of [
      ["Principal", claim.principal_id],
      ["Participant", claim.participant_id],
      ["Mode", claim.mode],
      ["Fence", String(fence)],
    ]) {
      const row = table
        .getByRole("row")
        .filter({ has: page.getByText(label, { exact: true }) });
      assert.equal(
        (
          await browser(() => row.getByRole("cell").last().textContent())
        ).trim(),
        value,
      );
    }
    assert.equal(
      await browser(() =>
        region.getByText("Not claimed.", { exact: true }).count(),
      ),
      0,
    );
    assert.equal(
      await browser(() => region.getByText(/^Last known:/).count()),
      0,
    );
  }
  async function freshPopulated() {
    await populated();
    assert.equal(
      await browser(() =>
        region.getByRole("button", { name: "Retry", exact: true }).count(),
      ),
      0,
    );
    assert.equal(await browser(() => region.locator("time").count()), 0);
    for (const text of [
      /^Showing claim state from /,
      "You do not have access to claim state.",
      "Could not load claim state.",
      "Its current state is unknown.",
    ]) {
      assert.equal(
        await browser(() => region.getByText(text, { exact: true }).count()),
        0,
      );
    }
  }
  async function stale() {
    await browser(() =>
      region
        .locator("output > span")
        .filter({
          hasText:
            /^Showing claim state from .+\. Refresh failed: server unavailable\.$/,
        })
        .waitFor(),
    );
    return browser(() => region.locator("time").getAttribute("datetime"));
  }
  async function recover(empty) {
    await transition("real");
    await response(200, () =>
      region.getByRole("button", { name: "Retry", exact: true }).click(),
    );
    await browser(() => region.locator("time").waitFor({ state: "detached" }));
    await (empty ? absent() : freshPopulated());
    assert.equal(
      await browser(() =>
        dialog.evaluate((node) => node.contains(document.activeElement)),
      ),
      true,
    );
  }
  async function save(saveSignal) {
    await writeFile(
      resolve(evidence, "claims-outage.json"),
      JSON.stringify(
        {
          subject: { project, ...sentinel, resource, fence },
          acquisition,
          helper_identity: identity && {
            auth_kind: identity.auth_kind,
            project_id: identity.project_id,
            principal_id: identity.principal_id,
            participant_id: "browser-competitor",
          },
          step,
          journal,
          events,
          violations,
          cleanup,
          duration_ms: performance.now() - started,
        },
        null,
        2,
      ),
      { mode: 0o600, signal: saveSignal },
    );
  }
  const timer = setTimeout(
    () => cancel(new Error("Claims stage exceeded 90 seconds")),
    90_000,
  );
  try {
    signal.addEventListener("abort", abort, { once: true });
    signal.throwIfAborted();
    assert.equal(typeof stopBrowserWork, "function");
    assert.equal(typeof openPage, "function");
    manifest = JSON.parse(
      await operation(() =>
        readFile(resolve(evidence, "scale-corpus.json"), {
          encoding: "utf8",
          signal: controller.signal,
        }),
      ),
    );
    sentinel = manifest.creates.find(({ id }) => id === "s1-scale-301");
    assert.equal(manifest.expected_ids.length, 301);
    assert.equal(sentinel?.type, "task");
    resource = `${sentinel.type}:${sentinel.id}`;
    selectedUrl = `${ui}/p/${project}/tasks/${sentinel.id}?sort=id:asc`;
    statePath = `${base}/claims/state/${encodeURIComponent(resource)}`;
    check();
    identity = await request("/api/whoami");
    assert.equal(identity.auth_kind, "d1-token");
    assert.equal(identity.project_id, project);
    assert.ok(identity.principal_id);
    baseline = await snapshot();
    await operation(() =>
      writeFile(
        resolve(evidence, "claims-baseline.json"),
        JSON.stringify(baseline, null, 2),
        { mode: 0o600, flag: "wx", signal: controller.signal },
      ),
    );
    assert.equal(baseline.task.entity.type, sentinel.type);
    assert.deepEqual(baseline.task.entity.data, sentinel.data);
    assert.equal(
      (await request(`${base}/queue?task_id=${sentinel.id}&limit=10`)).result
        .entries.length,
      0,
    );
    assert.equal((await request(statePath)).claim, null);
    assert.equal(
      (await request(`${base}/claims`)).claims.some(
        (c) => c.resource === resource || c.resource === sentinel.id,
      ),
      false,
    );
    // Close the inherited live Tasks target outside strict observation, then
    // measure a new Page in the same context. Navigation lifecycle completion
    // alone does not fence delayed requestfailed events from the old document;
    // a separate Page emitter prevents those events crossing this boundary.
    step = "retire prior Tasks document";
    await browser(() => page.close({ runBeforeUnload: false }));
    page = await browser(() => openPage());
    events.push({
      kind: "prior-document-retired",
      at_ms: performance.now() - started,
    });
    dialog = page.getByRole("dialog", {
      name: sentinel.data.title,
      exact: true,
    });
    region = dialog.getByRole("region", {
      name: "Claim State",
      exact: true,
    });
    fields = dialog.getByRole("region", { name: "Fields", exact: true });
    table = region.getByRole("table", { name: "Claim state", exact: true });
    disclosure = dialog.getByRole("button", {
      name: "Show data (1 keys)",
      exact: true,
    });
    page.on("request", onRequest);
    page.on("response", onResponse);
    page.on("requestfinished", onFinished);
    page.on("requestfailed", onFailed);
    await browser(async () => {
      await page.route(matches, handler);
      routeInstalled = true;
    });
    journal.push({
      phase: "setup",
      duration_ms: performance.now() - phaseStarted,
    });
    phaseStarted = performance.now();
    step = "pending";
    await browser(() => page.goto(selectedUrl, { timeout: 15_000 }));
    await wait(() => firstHeld, "first claims GET held");
    await browser(() =>
      region.getByText("Loading claim state…", { exact: true }).waitFor(),
    );
    assert.equal(
      await browser(() =>
        region.getByText("Not claimed.", { exact: true }).count(),
      ),
      0,
    );
    await browser(() =>
      dialog.getByRole("button", { name: "Expand", exact: true }).click(),
    );
    await browser(() => disclosure.click());
    drawerNode = await browser(() => dialog.elementHandle());
    fieldsNode = await browser(() => fields.elementHandle());
    dataNode = await browser(() =>
      dialog
        .getByRole("region", { name: "Technical details", exact: true })
        .locator("pre")
        .elementHandle(),
    );
    await oracle(step);

    step = "cold-503";
    await response(503, () => {
      mode = "503";
      releaseGate();
    });
    await browser(() =>
      region
        .getByText("Could not load claim state.", { exact: true })
        .waitFor(),
    );
    await browser(() =>
      region
        .getByText("Its current state is unknown.", { exact: true })
        .waitFor(),
    );
    assert.equal(
      await browser(() =>
        region.getByText("Not claimed.", { exact: true }).count(),
      ),
      0,
    );
    assert.equal(await browser(() => table.count()), 0);
    assert.equal(
      await browser(() =>
        region.getByRole("button", { name: "Retry", exact: true }).count(),
      ),
      1,
    );
    assert.ok(
      events.filter((e) => e.classification === "synthetic-503").length >= 2,
      "cold failure includes automatic retry",
    );
    await oracle(step);
    await recover(true);
    await oracle("cold-503 recovery");

    step = "stale-empty";
    await transition("503");
    acquisition = await request(`${base}/claims/acquire`, {
      resource,
      mode: "exclusive",
      ttl_ms: 600_000,
    });
    fence = acquisition.fence;
    assert.equal(acquisition.participant_id, "browser-competitor");
    assert.ok(Number.isSafeInteger(fence) && fence > 0);
    claim = (await request(statePath)).claim;
    assert.ok(claim);
    assert.equal(claim.expires_at, acquisition.expires_at);
    await response(503);
    await stale();
    await browser(() =>
      region.getByText("Last known: Not claimed.", { exact: true }).waitFor(),
    );
    assert.equal(
      await browser(() =>
        region.getByText("Not claimed.", { exact: true }).count(),
      ),
      0,
    );
    assert.equal(await browser(() => table.count()), 0);
    await oracle(step);
    await recover(false);
    await oracle("stale-empty recovery");

    step = "stale-populated";
    await transition("503");
    await response(503);
    const timestamp = await stale();
    assert.ok(timestamp);
    await populated();
    const previous = events.filter((e) => e.status === 503).length;
    await response(503);
    await response(503);
    assert.ok(events.filter((e) => e.status === 503).length >= previous + 2);
    const repeatedTimestamp = await stale();
    assert.equal(
      repeatedTimestamp,
      timestamp,
      "failed reads retain the last success timestamp",
    );
    events.push({
      kind: "fixed-stale-timestamp",
      first: timestamp,
      after_repeated_failures: repeatedTimestamp,
      additional_failed_reads:
        events.filter((e) => e.status === 503).length - previous,
    });
    await oracle(step);
    await recover(false);
    await oracle("stale-populated recovery");

    step = "403-withdrawal";
    await transition("403");
    await response(403);
    await browser(() =>
      region
        .getByText("You do not have access to claim state.", { exact: true })
        .waitFor(),
    );
    assert.equal(await browser(() => table.count()), 0);
    assert.equal(await browser(() => region.locator("time").count()), 0);
    assert.equal(
      await browser(() =>
        region.getByText("Not claimed.", { exact: true }).count(),
      ),
      0,
    );
    assert.equal(
      await browser(() => region.getByText(/^Last known:/).count()),
      0,
    );
    assert.equal(
      await browser(() =>
        region.getByRole("button", { name: "Retry", exact: true }).count(),
      ),
      0,
    );
    await oracle(step);
    await transition("real");
    await response(200);
    await freshPopulated();
    assert.equal(
      await browser(() =>
        region
          .getByText("You do not have access to claim state.", { exact: true })
          .count(),
      ),
      0,
    );
    assert.equal(await browser(() => region.locator("time").count()), 0);
    await oracle("403-withdrawal recovery");

    step = "healthy-empty";
    const released = await request(`${base}/claims/release`, {
      resource,
      fence,
    });
    assert.equal(released.ok, true);
    const releaseBarrier = requestSequence;
    events.push({
      kind: "release-barrier",
      request_id: releaseBarrier,
      generation,
      phase: step,
    });
    claim = null;
    const [finalList, finalState] = await Promise.all([
      request(`${base}/claims`),
      request(statePath),
    ]);
    assert.equal(finalState.claim, null);
    assert.equal(
      finalList.claims.some(
        (c) => c.resource === resource || c.resource === sentinel.id,
      ),
      false,
    );
    const finalResponse = await response(200, () => {}, releaseBarrier);
    assert.ok(
      requests.get(finalResponse.request()).request_id > releaseBarrier,
    );
    events.push({
      kind: "post-release-response",
      ...requests.get(finalResponse.request()),
    });
    await absent();
    await oracle(step);
    assert.ok(
      events.some(
        ({ kind, status }) => kind === "catalog-response" && status === 200,
      ),
    );
    await browser(() =>
      page.screenshot({
        path: resolve(evidence, "claims-healthy-empty.png"),
        fullPage: true,
        timeout: 15_000,
      }),
    );
    check();
    failed = false;
  } catch (error) {
    journal.push({
      phase: step,
      outcome: "failed",
      error: String(error.message).split("Call log:")[0],
      elapsed_ms: performance.now() - started,
    });
    throw error;
  } finally {
    clearTimeout(timer);
    if (failed) cancel(new Error("Claims stage failed"));
    releaseGate();
    // Abort disposes the connected client and kills/reaps its browser within 3s.
    // After cancellation, join actual operations (helper abort <=10s), then
    // drain <=5s, independent cleanup <=10s and save <=1s: <=26s within the
    // parent's 35s join. Keep parent cancellation attached through native drain.
    await Promise.allSettled([...operations, ...routes]);
    // A native deadline may have started disposal during the join itself.
    if (nativeStop) await nativeStop;
    let draining = true;
    try {
      await bounded(
        (async () => {
          if (routeInstalled && !cleanup.browser_work_stopped)
            await browser(() => page.unroute(matches, handler));
          // Include requests arriving while earlier requests are being drained.
          while (
            draining &&
            !cleanup.browser_work_stopped &&
            (routes.size || pending.size)
          ) {
            await wait(
              () =>
                Promise.all([
                  ...routes,
                  ...[...pending.values()].map(({ settled }) => settled),
                ]),
              "drain project requests",
            );
          }
        })(),
        5000,
        "remove claims route and drain project requests",
      );
      cleanup.route_removed = true;
    } catch {
      cleanup.errors.push("claims route/request cleanup failed");
      cancel(new Error("Claims drain failed"));
      await Promise.allSettled([...operations, ...routes, nativeStop]);
      cleanup.route_removed = cleanup.browser_work_stopped;
    } finally {
      draining = false;
    }
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("requestfinished", onFinished);
    page.off("requestfailed", onFailed);
    signal.removeEventListener("abort", abort);
    cleanup.listeners_removed = true;
    // Successful teardown has removed the route and drained healthy reads before
    // aborting, so it cannot turn a late real poll into a synthetic transport error.
    controller.abort();
    try {
      const cleanupSignal = AbortSignal.timeout(10_000);
      const cleanupRequest = (path, body) =>
        helperRequest(path, body, cleanupSignal);
      if (statePath) {
        cleanup.claim_absence_check = "checking";
        if (fence !== null && (await cleanupRequest(statePath)).claim) {
          const released = await cleanupRequest(`${base}/claims/release`, {
            resource,
            fence,
          });
          assert.equal(released.ok, true);
        }
        assert.equal((await cleanupRequest(statePath)).claim, null);
        assert.equal(
          (await cleanupRequest(`${base}/claims`)).claims.some(
            (c) => c.resource === resource || c.resource === sentinel.id,
          ),
          false,
        );
        cleanup.claim_absent = true;
        cleanup.claim_absence_check = "verified-list-and-state";
      }
    } catch {
      cleanup.errors.push("fenced claim cleanup failed");
    }
    await bounded(save(), 1000, "save final claims evidence");
    assert.deepEqual(cleanup.errors, [], "claims cleanup failed");
    assert.deepEqual(
      violations,
      [],
      "unexpected project browser failures after final drain",
    );
  }
}
