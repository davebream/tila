import {
  activeAttempt,
  attemptStatus,
  evidenceLink,
  latestFinished,
  retryable,
} from "@/lib/execution";
import { attempt } from "../mocks/attempts";

const stopped = {
  status: "failure" as const,
  evidence: [],
  execution_stopped: true,
  unresolved_external_execution: false,
};
const failed = attempt({
  id: "att-0",
  state: "terminal",
  finished_at: 5,
  outcome: stopped,
});

test("an active attempt, the latest result and the request state stay apart", () => {
  const running = attempt({ cancellation_requested: true });
  expect(activeAttempt([running, failed])).toBe(running);
  expect(latestFinished([running, failed])).toBe(failed);
  expect(attemptStatus(running)).toBe(
    "Running · cancellation requested, stop not yet confirmed",
  );
  expect(attemptStatus(failed)).toBe("Finished · execution confirmed stopped");
});

test("retry needs a stopped, non-successful, resolved result", () => {
  expect(retryable(failed)).toBe(true);
  expect(retryable(null)).toBe(false);
  expect(
    retryable({
      ...failed,
      outcome: { ...stopped, unresolved_external_execution: true },
    }),
  ).toBe(false);
  expect(
    retryable({
      ...failed,
      outcome: { ...stopped, status: "success" },
    }),
  ).toBe(false);
});

test("evidence recognises pull requests, links and artifact references", () => {
  expect(evidenceLink("https://github.com/acme/app/pull/12")).toEqual({
    kind: "pull",
    href: "https://github.com/acme/app/pull/12",
    label: "PR #12 · acme/app",
  });
  expect(evidenceLink("https://ci.example/run/1").kind).toBe("url");
  expect(evidenceLink("artifact:reports/run-1.json")).toEqual({
    kind: "artifact",
    key: "reports/run-1.json",
    label: "reports/run-1.json",
  });
  expect(evidenceLink("tests passed")).toEqual({
    kind: "text",
    label: "tests passed",
  });
});
