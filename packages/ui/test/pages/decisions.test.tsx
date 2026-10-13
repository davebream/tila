import { DecisionsPage } from "@/pages/decisions";
import userEvent from "@testing-library/user-event";
import type { Question } from "@tila/schemas";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router";
import { server } from "../mocks/server";
import { renderWithProviders, screen, waitFor, within } from "../test-utils";

const ME = "github:example:1";
const QID = "00000000-0000-4000-8000-000000000001";
let role = "participant";
let question: Question;
let listed: URLSearchParams[] = [];

function makeQuestion(overrides: Partial<Question> = {}): Question {
  return {
    id: QID,
    text: "Should the migration drop the legacy column?\nIt still has 3 readers.",
    task_id: "BUG-1",
    attempt_id: "att-1",
    attempt_revision: 4,
    attempt_fence: 2,
    requester: {
      principal_id: "github:example:9",
      participant_id: "worker-mac",
    },
    session: null,
    requester_binding: {
      agent_id: "mac-worker",
      consumer_binding_id: "00000000-0000-4000-8000-0000000000aa",
      binding_epoch: 1,
    },
    responder_principal_id: ME,
    escalated: false,
    state: "open",
    revision: 2,
    answer: null,
    routing: [
      {
        responder_principal_id: ME,
        escalated: false,
        reason: null,
        actor: {
          principal_id: "github:example:9",
          participant_id: "worker-mac",
        },
        revision: 1,
        at: Date.now() - 60_000,
      },
    ],
    discussion: [],
    predecessor_id: null,
    invalidation_reason: null,
    created_at: Date.now() - 60_000,
    updated_at: Date.now() - 60_000,
    ...overrides,
  };
}

const view = () => ({ answer_applicable: false, question });

function renderDecisions(route = "/p/test-project/decisions") {
  return renderWithProviders(
    <Routes>
      <Route path="/p/:projectId/decisions" element={<DecisionsPage />} />
      <Route
        path="/p/:projectId/decisions/:questionId"
        element={<DecisionsPage />}
      />
    </Routes>,
    { route },
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  role = "participant";
  listed = [];
  question = makeQuestion();
  server.use(
    http.get("*/api/whoami", () =>
      HttpResponse.json({
        ok: true,
        project_id: "test-project",
        token_name: "dev",
        scopes: "write",
        role,
        principal_id: ME,
      }),
    ),
    http.get("*/projects/test-project/questions", ({ request }) => {
      const params = new URL(request.url).searchParams;
      listed.push(params);
      const match =
        (!params.get("state") || params.get("state") === question.state) &&
        (!params.get("responder_principal_id") ||
          params.get("responder_principal_id") ===
            question.responder_principal_id) &&
        (!params.get("escalated") ||
          params.get("escalated") === String(question.escalated));
      return HttpResponse.json({
        ok: true,
        result: {
          questions: match ? [view()] : [],
          next_after_id: null,
          total: match ? 1 : 0,
        },
      });
    }),
    http.get("*/projects/test-project/questions/:id", () =>
      HttpResponse.json({ ok: true, result: view() }),
    ),
  );
});

test("the inbox lists open questions waiting on the signed-in principal", async () => {
  renderDecisions();
  const table = await screen.findByRole("table", { name: "Waiting on me" });
  expect(
    within(table).getByRole("link", { name: /Should the migration drop/ }),
  ).toHaveAttribute("href", `/p/test-project/decisions/${QID}`);
  expect(within(table).getByText(`${ME} (you)`)).toBeInTheDocument();
  expect(listed[0].get("responder_principal_id")).toBe(ME);
  expect(listed[0].get("state")).toBe("open");
  expect(screen.getByText("1 question matches")).toBeInTheDocument();
});

test("escalated only is filtered by the server, so its total is exact", async () => {
  question = makeQuestion({ escalated: true });
  const user = userEvent.setup();
  renderDecisions("/p/test-project/decisions?view=open");
  await screen.findByRole("table", { name: "All open" });
  expect(listed.at(-1)?.has("escalated")).toBe(false);

  await user.click(screen.getByRole("button", { name: "Escalated only" }));
  await waitFor(() =>
    expect(Object.fromEntries(listed.at(-1) ?? [])).toEqual({
      state: "open",
      escalated: "true",
      limit: "50",
    }),
  );
  expect(await screen.findByText("1 question matches")).toBeInTheDocument();

  question = makeQuestion();
  await user.click(screen.getByRole("link", { name: "Waiting on me" }));
  expect(
    await screen.findByText("No escalated questions in this view."),
  ).toBeInTheDocument();
  expect(screen.queryByText(/question matches/)).not.toBeInTheDocument();
});

test("answers with the question's correlation and a matching idempotency key", async () => {
  const user = userEvent.setup();
  const sent: Array<{ body: Record<string, unknown>; key: string | null }> = [];
  server.use(
    http.post(
      `*/projects/test-project/questions/${QID}/answer`,
      async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        sent.push({ body, key: request.headers.get("Idempotency-Key") });
        question = makeQuestion({
          state: "answered",
          revision: 3,
          answer: {
            text: String(body.text),
            actor: { principal_id: ME, participant_id: "dashboard-x" },
            revision: 3,
            at: Date.now(),
          },
        });
        return HttpResponse.json({ ok: true, result: view() });
      },
    ),
  );
  renderDecisions(`/p/test-project/decisions/${QID}`);
  const drawer = await screen.findByRole("dialog", { name: "Decision" });
  expect(
    await within(drawer).findByText(/It still has 3 readers\./),
  ).toBeInTheDocument();
  expect(within(drawer).getByRole("link", { name: "BUG-1" })).toHaveAttribute(
    "href",
    "/p/test-project/tasks/BUG-1",
  );
  expect(within(drawer).getByRole("link", { name: "att-1" })).toHaveAttribute(
    "href",
    "/p/test-project/tasks/BUG-1?attempt=att-1",
  );
  expect(within(drawer).getByText(/agent mac-worker/)).toBeInTheDocument();
  await user.type(
    within(drawer).getByRole("textbox", { name: /your answer/i }),
    "Keep it for one release.",
  );
  await user.click(within(drawer).getByRole("button", { name: "Send answer" }));
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0].body).toMatchObject({
    question_id: QID,
    expected_revision: 2,
    attempt_id: "att-1",
    attempt_revision: 4,
    attempt_fence: 2,
    text: "Keep it for one release.",
  });
  expect(sent[0].key).toBe(sent[0].body.idempotency_key);
  const answer = await within(drawer).findByRole("region", { name: "Answer" });
  expect(
    within(answer).getByText("Keep it for one release."),
  ).toBeInTheDocument();
});

test("an interrupted answer is retried with the same operation", async () => {
  const user = userEvent.setup();
  const sent: unknown[] = [];
  server.use(
    http.post(
      `*/projects/test-project/questions/${QID}/answer`,
      async ({ request }) => {
        sent.push(await request.json());
        if (sent.length === 1) return HttpResponse.error();
        return HttpResponse.json({ ok: true, result: view() });
      },
    ),
  );
  renderDecisions(`/p/test-project/decisions/${QID}`);
  const drawer = await screen.findByRole("dialog", { name: "Decision" });
  await user.type(
    await within(drawer).findByRole("textbox", { name: /your answer/i }),
    "Yes",
  );
  await user.click(within(drawer).getByRole("button", { name: "Send answer" }));
  expect(
    await within(drawer).findByText(/did not confirm the answer/),
  ).toBeInTheDocument();
  expect(
    within(drawer).getByRole("textbox", { name: /your answer/i }),
  ).toBeDisabled();
  await user.click(within(drawer).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(sent).toHaveLength(2));
  expect(sent[1]).toEqual(sent[0]);
});

test("a superseded question keeps the unsent answer visible", async () => {
  const user = userEvent.setup();
  server.use(
    http.post(`*/projects/test-project/questions/${QID}/answer`, () => {
      question = makeQuestion({
        state: "superseded",
        revision: 3,
        invalidation_reason: "Attempt was cancelled",
      });
      return HttpResponse.json(
        {
          ok: false,
          error: {
            code: "question-invalid-state",
            message: "Question is not open",
          },
        },
        { status: 409 },
      );
    }),
  );
  renderDecisions(`/p/test-project/decisions/${QID}`);
  const drawer = await screen.findByRole("dialog", { name: "Decision" });
  await user.type(
    await within(drawer).findByRole("textbox", { name: /your answer/i }),
    "Drop it",
  );
  await user.click(within(drawer).getByRole("button", { name: "Send answer" }));
  const unsent = await within(drawer).findByRole("region", {
    name: "Your unsent answer",
  });
  expect(within(unsent).getByText("Drop it")).toBeInTheDocument();
  expect(
    within(unsent).getByText(/This question is superseded\./),
  ).toBeInTheDocument();
  expect(within(drawer).getByText(/Attempt was cancelled/)).toBeInTheDocument();
});

test("a draft survives closing and reopening the drawer", async () => {
  const user = userEvent.setup();
  renderDecisions(`/p/test-project/decisions/${QID}`);
  const drawer = await screen.findByRole("dialog", { name: "Decision" });
  await user.type(
    await within(drawer).findByRole("textbox", { name: /your answer/i }),
    "Half written",
  );
  await user.click(within(drawer).getByRole("button", { name: "Close" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Decision" }),
    ).not.toBeInTheDocument(),
  );
  await user.click(
    await screen.findByRole("link", { name: /Should the migration/ }),
  );
  expect(
    await screen.findByRole("textbox", { name: /your answer/i }),
  ).toHaveValue("Half written");
});

test("losing access while the drawer is open keeps the draft and removes the form", async () => {
  const user = userEvent.setup();
  server.use(
    http.post(`*/projects/test-project/questions/${QID}/answer`, () => {
      role = "viewer";
      return HttpResponse.json(
        {
          ok: false,
          error: { code: "permission-denied", message: "No access" },
        },
        { status: 403 },
      );
    }),
  );
  renderDecisions(`/p/test-project/decisions/${QID}`);
  const drawer = await screen.findByRole("dialog", { name: "Decision" });
  await user.type(
    await within(drawer).findByRole("textbox", { name: /your answer/i }),
    "Keep me",
  );
  await user.click(within(drawer).getByRole("button", { name: "Send answer" }));
  expect(
    await within(drawer).findByText(
      "This credential can read decisions but not answer them.",
    ),
  ).toBeInTheDocument();
  const unsent = within(drawer).getByRole("region", {
    name: "Your unsent answer",
  });
  expect(within(unsent).getByText("Keep me")).toBeInTheDocument();
});

test("only the designated responder answers; others may escalate to an owner", async () => {
  const user = userEvent.setup();
  role = "maintainer";
  question = makeQuestion({ responder_principal_id: "github:example:7" });
  let sent: Record<string, unknown> | undefined;
  server.use(
    http.post(
      `*/projects/test-project/questions/${QID}/escalate`,
      async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true, result: view() });
      },
    ),
  );
  renderDecisions(`/p/test-project/decisions/${QID}`);
  const drawer = await screen.findByRole("dialog", { name: "Decision" });
  expect(
    await within(drawer).findByText(
      "Only the principal it is waiting on can answer it.",
    ),
  ).toBeInTheDocument();
  expect(
    within(drawer).queryByRole("textbox", { name: /your answer/i }),
  ).not.toBeInTheDocument();
  await user.click(within(drawer).getByText("Escalate to an owner"));
  await user.type(
    within(drawer).getByRole("textbox", { name: /owner principal/i }),
    "github:example:2",
  );
  await user.type(
    within(drawer).getByRole("textbox", { name: /reason/i }),
    "Needs product call",
  );
  await user.click(within(drawer).getByRole("button", { name: "Escalate" }));
  await waitFor(() =>
    expect(sent).toMatchObject({
      responder_principal_id: "github:example:2",
      reason: "Needs product call",
      expected_revision: 2,
    }),
  );
});

test("an escalated question waits for an owner", async () => {
  question = makeQuestion({ escalated: true });
  renderDecisions(`/p/test-project/decisions/${QID}`);
  const drawer = await screen.findByRole("dialog", { name: "Decision" });
  expect(
    await within(drawer).findByText(
      "This question was escalated to an owner; only an owner can answer it.",
    ),
  ).toBeInTheDocument();
  expect(within(drawer).getByText("Escalated to owner")).toBeInTheDocument();
});

test("the answer form works from the keyboard alone", async () => {
  const user = userEvent.setup();
  let sent = false;
  server.use(
    http.post(`*/projects/test-project/questions/${QID}/answer`, () => {
      sent = true;
      return HttpResponse.json({ ok: true, result: view() });
    }),
  );
  renderDecisions(`/p/test-project/decisions/${QID}`);
  const box = await screen.findByRole("textbox", { name: /your answer/i });
  box.focus();
  await user.keyboard("Ship it");
  await user.tab(); // Discard draft
  expect(screen.getByRole("button", { name: "Discard draft" })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "Send answer" })).toHaveFocus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(sent).toBe(true));
});
