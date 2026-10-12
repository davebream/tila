import {
  JournalReportForm,
  ProjectReportDetails,
} from "@/components/journal-report";
import { JournalPage } from "@/pages/journal";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { server } from "../mocks/server";
import { renderWithProviders, screen, waitFor } from "../test-utils";

const input = {
  event_name: "pipeline.tests_passed",
  event_version: 87,
  target: { kind: "project" },
  data: { text: "<script>alert(1)</script>" },
  occurred_at: "2000-01-01T00:00:00Z",
};
const receipt = {
  ok: true,
  event: {
    seq: 42,
    t: Date.now(),
    kind: "custom.reported",
    resource: "project:test",
    principal_id: "principal",
    participant_id: "participant",
    environment: {},
    token_id: "credential",
    fence: null,
    data: input,
  },
  dedup_expires_at: Date.now() + 604800000,
};
const identity = (capabilities = ["journal:append"]) =>
  server.use(
    http.get("*/api/whoami", () =>
      HttpResponse.json({
        ok: true,
        project_id: "test",
        policy: { role: "participant", capabilities },
      }),
    ),
  );

describe("project report UI", () => {
  it("renders unknown versions with occurrence time and treats payload markup as text", () => {
    renderWithProviders(<ProjectReportDetails data={input} projectId="test" />);
    expect(screen.getByText("Project report")).toBeInTheDocument();
    expect(screen.getByText("pipeline.tests_passed")).toBeInTheDocument();
    expect(screen.getByText("v87")).toBeInTheDocument();
    expect(screen.getByText(/Occurred \(reported\): 2000/)).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
  });
  it("retains the retry key after a lost response and emits the accepted sequence", async () => {
    identity();
    const keys: (string | null)[] = [];
    server.use(
      http.post("*/projects/test/journal", ({ request }) => {
        keys.push(request.headers.get("Idempotency-Key"));
        return keys.length === 1
          ? HttpResponse.error()
          : HttpResponse.json(receipt);
      }),
    );
    const accepted = vi.fn();
    renderWithProviders(
      <JournalReportForm projectId="test" onAccepted={accepted} />,
    );
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Report event" }),
    );
    await user.type(
      screen.getByLabelText("Event name"),
      "pipeline.tests_passed",
    );
    await user.click(screen.getByRole("button", { name: "Submit report" }));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Submit report" }));
    expect(await screen.findByRole("status")).toHaveTextContent("#42");
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(accepted).toHaveBeenCalledOnce();
  });
  it("hides append when the capability is absent", async () => {
    identity([]);
    const seen = vi.fn();
    server.use(
      http.get("*/api/whoami", () => {
        seen();
        return HttpResponse.json({
          project_id: "test",
          policy: { role: "viewer", capabilities: ["journal:read"] },
        });
      }),
    );
    renderWithProviders(
      <JournalReportForm projectId="test" onAccepted={() => {}} />,
    );
    await waitFor(() => expect(seen).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: "Report event" }),
    ).not.toBeInTheDocument();
  });
  it("sends custom-name and correlation filters to the service", async () => {
    const queries: URLSearchParams[] = [];
    server.use(
      http.get("*/projects/*/journal", ({ request }) => {
        queries.push(new URL(request.url).searchParams);
        return HttpResponse.json({ ok: true, events: [] });
      }),
    );
    renderWithProviders(<JournalPage />);
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText("Filter journal by event name"),
      "pipeline.tests_passed",
    );
    await user.type(
      screen.getByLabelText("Filter journal by correlation ID"),
      "run-123",
    );
    await waitFor(() =>
      expect(
        queries.some(
          (query) =>
            query.get("event_name") === "pipeline.tests_passed" &&
            query.get("correlation_id") === "run-123",
        ),
      ).toBe(true),
    );
  });
});
