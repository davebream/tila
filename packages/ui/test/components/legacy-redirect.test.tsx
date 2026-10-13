import { EntityAlias, LegacyRedirect } from "@/components/legacy-redirect";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  type Location,
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router";

let currentLocation: Location;

function Probe() {
  currentLocation = useLocation();
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      Back
    </button>
  );
}

function renderAt(entries: string[]) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <Routes>
        <Route path="/start" element={<Probe />} />
        <Route
          path="/p/:projectId/entities/*"
          element={<EntityAlias projectId="acme" />}
        />
        <Route path="/p/:projectId/*" element={<Probe />} />
        <Route path="*" element={<LegacyRedirect projectId="acme" />} />
      </Routes>
    </MemoryRouter>,
  );
}

const href = () =>
  `${currentLocation.pathname}${currentLocation.search}${currentLocation.hash}`;

describe("LegacyRedirect", () => {
  test.each([
    ["/tasks", "/p/acme/tasks"],
    ["/tasks/task-1?sort=updated", "/p/acme/tasks/task-1?sort=updated"],
    [
      "/rooms/room-1?thread=m-1#latest",
      "/p/acme/rooms/room-1?thread=m-1#latest",
    ],
    ["/deliveries/agent-1/d-1", "/p/acme/deliveries/agent-1/d-1"],
    ["/agents/agent-1/deliveries/d-1", "/p/acme/agents/agent-1/deliveries/d-1"],
    ["/records/config/a/b", "/p/acme/records/config/a/b"],
    [
      "/artifacts/task/t1/r.md?q=report",
      "/p/acme/artifacts/task/t1/r.md?q=report",
    ],
    ["/journal?resource=task:t1", "/p/acme/journal?resource=task:t1"],
    ["/runtime/agent-1", "/p/acme/runtime/agent-1"],
    ["/settings", "/p/acme/settings"],
    ["/entities", "/p/acme/tasks"],
    ["/entities/task-1", "/p/acme/tasks/task-1"],
  ])("%s keeps its sub-path, query and fragment", async (from, to) => {
    renderAt([from]);
    await screen.findByRole("button", { name: "Back" });
    expect(href()).toBe(to);
  });

  test("an unknown flat path opens the default project page", async () => {
    renderAt(["/nowhere"]);
    await screen.findByRole("button", { name: "Back" });
    expect(currentLocation.pathname).toMatch(/^\/p\/acme\/[a-z]+$/);
  });

  test("replaces the alias in history so Back skips it", async () => {
    const user = userEvent.setup();
    renderAt(["/start", "/rooms/room-1"]);
    await screen.findByRole("button", { name: "Back" });
    expect(currentLocation.pathname).toBe("/p/acme/rooms/room-1");
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(currentLocation.pathname).toBe("/start");
  });
});

describe("EntityAlias", () => {
  test("maps project entity links to the task drawer", async () => {
    renderAt(["/p/acme/entities/task-1?sort=updated"]);
    await screen.findByRole("button", { name: "Back" });
    expect(href()).toBe("/p/acme/tasks/task-1?sort=updated");
  });
});
