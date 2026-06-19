import { JournalPage } from "@/pages/journal";
import { within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
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

  // Task 11: artifact-vs-task branch in ResourceLink
  test("artifact event primary link targets artifact view not task", async () => {
    // Override the journal handler to return an artifact event WITH r2_key
    server.use(
      http.get("*/projects/*/journal", () => {
        return HttpResponse.json({
          ok: true,
          events: [
            {
              seq: 1,
              t: Date.now() - 5000,
              kind: "artifact.produced",
              resource: "produced/x/file.txt",
              actor: "test-user",
              token_id: null,
              fence: null,
              data: { r2_key: "produced/x/file.txt" },
              source: "cli",
              source_version: "0.4.2",
            },
          ],
        });
      }),
    );

    renderWithProviders(<JournalPage />);

    await waitFor(() => {
      expect(screen.getByText("#1")).toBeInTheDocument();
    });

    // Find the resource cell — it's the 4th cell in the row
    const rows = screen.getAllByRole("row");
    // First row is the header; second row is the data row
    const dataRow = rows[1];
    const links = within(dataRow).getAllByRole("link");

    // PRIMARY link (first link) must point to /artifacts/... not /tasks/...
    expect(links[0].getAttribute("href")).toMatch(
      /\/artifacts\/produced\/x\/file\.txt$/,
    );

    // No link should end with /tasks/<r2_key>
    for (const link of links) {
      expect(link.getAttribute("href")).not.toMatch(
        /\/tasks\/produced\/x\/file\.txt$/,
      );
    }
  });
});
