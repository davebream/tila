import { QuerySection, SectionNotice } from "@/components/ui/query-section";
import { ApiError } from "@/lib/api";
import type { SectionState } from "@/lib/query-state";
import { formatTime } from "@/lib/time";
import userEvent from "@testing-library/user-event";
import { render, screen } from "../test-utils";

const UPDATED_AT = new Date(2026, 9, 10, 12, 3, 10).getTime();

function ready(
  over: Partial<Extract<SectionState<string[]>, { phase: "ready" }>> = {},
) {
  return {
    phase: "ready",
    data: ["row"],
    empty: false,
    updatedAt: UPDATED_AT,
    stale: null,
    ...over,
  } satisfies SectionState<string[]>;
}

function section(state: SectionState<string[]>, onRetry?: () => void) {
  return render(
    <QuerySection
      state={state}
      label="claim state"
      empty="Not claimed."
      onRetry={onRetry}
    >
      {(rows) => (
        <ul>
          {rows.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </QuerySection>,
  );
}

describe("QuerySection", () => {
  test("pending shows loading text and marks the region busy, not empty", () => {
    const { container } = section({ phase: "pending", paused: false });

    expect(screen.getByText("Loading claim state…")).toBeInTheDocument();
    expect(screen.queryByText("Not claimed.")).not.toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute("aria-busy", "true");
  });

  test("an offline-paused first fetch says it is waiting for the network", () => {
    section({ phase: "pending", paused: true });
    expect(
      screen.getByText("Waiting for network to load claim state…"),
    ).toBeInTheDocument();
  });

  test("ready renders children and is not busy", () => {
    const { container } = section(ready());

    expect(screen.getByText("row")).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute("aria-busy", "false");
  });

  test("a fresh empty success shows the affirmative absence text", () => {
    section(ready({ data: [], empty: true }));
    expect(screen.getByText("Not claimed.")).toBeInTheDocument();
  });

  test("forbidden is a plain sentence with no retry and no empty text", () => {
    section(
      { phase: "failed", kind: "forbidden", error: new Error("x") },
      vi.fn(),
    );

    expect(
      screen.getByText("You do not have access to claim state."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Not claimed.")).not.toBeInTheDocument();
  });

  test("unavailable is an alert with the code and a working retry", async () => {
    const onRetry = vi.fn();
    section(
      {
        phase: "failed",
        kind: "unavailable",
        error: new ApiError("do-unreachable", "x", undefined, 503),
      },
      onRetry,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Could not load claim state.");
    expect(alert).toHaveTextContent("Its current state is unknown.");
    expect(alert).toHaveTextContent("do-unreachable");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test("retry parks focus on the section so it survives the failure UI unmounting", async () => {
    const { container } = section(
      { phase: "failed", kind: "unavailable", error: new Error("x") },
      vi.fn(),
    );

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(container.firstElementChild).toHaveFocus();
  });

  test("a failed section without onRetry offers no retry", () => {
    section({ phase: "failed", kind: "error", error: new Error("x") });
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
  });

  test("an expired session asks the viewer to sign in", () => {
    section({
      phase: "failed",
      kind: "unauthenticated",
      error: new Error("x"),
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Session expired.");
  });

  test("stale keeps the rows and states the last-success time and the failure", async () => {
    const onRetry = vi.fn();
    section(
      ready({
        stale: {
          kind: "unavailable",
          error: new ApiError("do-unreachable", "x", undefined, 503),
          failedAt: UPDATED_AT + 5000,
        },
      }),
      onRetry,
    );

    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent(
      `Showing claim state from ${formatTime(UPDATED_AT)}. Refresh failed: server unavailable.`,
    );
    expect(screen.getByText("row")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test("stale text does not change between consecutive failed polls", () => {
    const error = new ApiError("do-unreachable", "x", undefined, 503);
    const { rerender } = section(
      ready({ stale: { kind: "unavailable", error, failedAt: 1 } }),
    );
    const before = screen.getByRole("status").textContent;

    rerender(
      <QuerySection
        state={ready({ stale: { kind: "unavailable", error, failedAt: 99 } })}
        label="claim state"
        empty="Not claimed."
      >
        {(rows) => (
          <ul>
            {rows.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </QuerySection>,
    );

    expect(screen.getByRole("status").textContent).toBe(before);
  });

  test("stale empty never shows the bare affirmative sentence", () => {
    section(
      ready({
        data: [],
        empty: true,
        stale: {
          kind: "unavailable",
          error: new Error("x"),
          failedAt: UPDATED_AT + 1,
        },
      }),
    );

    expect(screen.queryByText("Not claimed.")).not.toBeInTheDocument();
    expect(screen.getByText("Last known: Not claimed.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Refresh failed");
  });

  test("a network failure is described as unreachable, not as a server fault", () => {
    section(
      ready({
        stale: {
          kind: "unavailable",
          error: new ApiError("network-error", "x"),
          failedAt: 1,
        },
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Refresh failed: cannot reach server.",
    );
  });

  test("rows keep their DOM node when a section flips from ready to stale", () => {
    const { rerender } = section(ready());
    const row = screen.getByText("row");

    rerender(
      <QuerySection
        state={ready({
          stale: { kind: "unavailable", error: new Error("x"), failedAt: 1 },
        })}
        label="claim state"
        empty="Not claimed."
      >
        {(rows) => (
          <ul>
            {rows.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </QuerySection>,
    );

    expect(screen.getByText("row")).toBe(row);
  });
});

describe("SectionNotice", () => {
  test("renders its message and an optional retry", async () => {
    const onRetry = vi.fn();
    render(
      <SectionNotice onRetry={onRetry}>
        Some types may be missing.
      </SectionNotice>,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Some types may be missing.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
