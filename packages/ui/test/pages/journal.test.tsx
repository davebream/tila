import { JournalPage } from "@/pages/journal";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "../test-utils";

describe("JournalPage", () => {
  test("renders events from API data", async () => {
    renderWithProviders(<JournalPage />);

    // Wait for events to load
    await waitFor(() => {
      expect(screen.getByText("#1")).toBeInTheDocument();
    });

    // Verify all event sequence numbers are present
    expect(screen.getByText("#2")).toBeInTheDocument();
    expect(screen.getByText("#3")).toBeInTheDocument();
    expect(screen.getByText("#4")).toBeInTheDocument();

    // Verify event kinds are present
    const entityCreated = screen.getAllByText("entity.created");
    expect(entityCreated.length).toBeGreaterThan(0);

    const claimAcquired = screen.getAllByText("claim.acquired");
    expect(claimAcquired.length).toBeGreaterThan(0);

    const artifactProduced = screen.getAllByText("artifact.produced");
    expect(artifactProduced.length).toBeGreaterThan(0);

    const schemaApplied = screen.getAllByText("schema.applied");
    expect(schemaApplied.length).toBeGreaterThan(0);
  });

  test("applies correct CSS classes to kind badges", async () => {
    renderWithProviders(<JournalPage />);

    // Wait for events to load
    await waitFor(() => {
      expect(screen.getByText("#1")).toBeInTheDocument();
    });

    // Get all badges - filter to find the ones in event rows (not in dropdown)
    // The badge is a span with data-slot="badge"
    const entityBadges = screen.getAllByText("entity.created");
    const entityBadge = entityBadges.find(
      (el) => el.getAttribute("data-slot") === "badge",
    );
    expect(entityBadge?.className).toContain("text-status-green");

    const claimBadges = screen.getAllByText("claim.acquired");
    const claimBadge = claimBadges.find(
      (el) => el.getAttribute("data-slot") === "badge",
    );
    expect(claimBadge?.className).toContain("text-status-amber");

    const artifactBadges = screen.getAllByText("artifact.produced");
    const artifactBadge = artifactBadges.find(
      (el) => el.getAttribute("data-slot") === "badge",
    );
    expect(artifactBadge?.className).toContain("text-status-green");

    const schemaBadges = screen.getAllByText("schema.applied");
    const schemaBadge = schemaBadges.find(
      (el) => el.getAttribute("data-slot") === "badge",
    );
    expect(schemaBadge?.className).toContain("text-status-green");
  });

  test("renders author affixes for events", async () => {
    renderWithProviders(<JournalPage />);

    // Wait for events to load
    await waitFor(() => {
      expect(screen.getByText("#1")).toBeInTheDocument();
    });

    // Event #1 source=cli → AuthorAffix "cli"
    const cliAffixes = screen.getAllByText("cli");
    expect(cliAffixes.length).toBeGreaterThan(0);

    // Event #2 source=mcp → AuthorAffix "agent"
    const agentAffixes = screen.getAllByText("agent");
    expect(agentAffixes.length).toBeGreaterThan(0);

    // Event #4 source=dashboard → AuthorAffix "user"
    const userAffixes = screen.getAllByText("user");
    expect(userAffixes.length).toBeGreaterThan(0);

    // Event #3 source=null → AuthorAffix "sys"
    const sysAffixes = screen.getAllByText("sys");
    expect(sysAffixes.length).toBeGreaterThan(0);
  });

  test("toggles data display when data button clicked", async () => {
    const user = userEvent.setup();

    renderWithProviders(<JournalPage />);

    // Wait for events to load
    await waitFor(() => {
      expect(screen.getByText("#1")).toBeInTheDocument();
    });

    // Find the data toggle button for event #1 (entity.created has data)
    const toggleButton = screen.getByLabelText("Toggle data for event #1");

    // Initially, data should not be visible
    expect(screen.queryByText(/"type":/)).not.toBeInTheDocument();

    // Click to show data
    await user.click(toggleButton);

    // Data should now be visible
    await waitFor(() => {
      expect(screen.getByText(/"type":/)).toBeInTheDocument();
    });

    // Click to hide data
    await user.click(toggleButton);

    // Data should be hidden again
    await waitFor(() => {
      expect(screen.queryByText(/"type":/)).not.toBeInTheDocument();
    });
  });
});
