import { CommandPalette } from "@/components/ui/command-palette";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { useState } from "react";
import { server } from "./mocks/server";
import { renderWithProviders, screen, waitFor } from "./test-utils";

// Harness that drives open/close state so onOpenChange works
function PaletteHarness({ initialOpen = true }: { initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return <CommandPalette open={open} onClose={() => setOpen(false)} />;
}

describe("CommandPalette", () => {
  test("uses useTaskIndex: requests compact=true and limit=200", async () => {
    const capturedRequests: URLSearchParams[] = [];

    server.use(
      http.get("*/projects/*/tasks", ({ request }) => {
        capturedRequests.push(new URL(request.url).searchParams);
        return HttpResponse.json({
          ok: true,
          entities: [{ id: "palette-task-1", type: "task" }],
        });
      }),
    );

    renderWithProviders(<CommandPalette open onClose={() => {}} />);

    // Wait for the index request to fire
    await waitFor(() => {
      expect(capturedRequests.length).toBeGreaterThan(0);
    });

    // Positive assertion: a request with compact=true and limit=200 must have fired
    const indexRequest = capturedRequests.find(
      (p) => p.get("compact") === "true" && p.get("limit") === "200",
    );
    expect(indexRequest).toBeDefined();

    // The compact entity's id should appear in the rendered palette list
    await waitFor(() => {
      expect(screen.getByText("palette-task-1")).toBeInTheDocument();
    });
  });

  test("focus moves to the search input when palette opens", async () => {
    renderWithProviders(<PaletteHarness initialOpen />);

    // The input has role="combobox" (explicitly set in source)
    await waitFor(() => {
      const input = screen.getByRole("combobox");
      expect(document.activeElement).toBe(input);
    });
  });

  test("Escape calls onClose", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PaletteHarness initialOpen />);

    // Wait for palette to be visible
    await waitFor(() => {
      expect(screen.getByRole("combobox")).toBeInTheDocument();
    });

    await user.keyboard("{Escape}");

    // After Escape the palette should unmount (Dialog.Root controls mounting)
    await waitFor(() => {
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    });
  });

  test("Tab stays within the dialog — does not escape to document body", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PaletteHarness initialOpen />);

    await waitFor(() => {
      expect(screen.getByRole("combobox")).toBeInTheDocument();
    });

    // Tab once — focus should remain somewhere inside the dialog, not on body
    await user.tab();
    expect(document.activeElement).not.toBe(document.body);

    // The active element should be inside the dialog content
    const dialog = document.querySelector("[data-radix-dialog-content]");
    if (dialog) {
      expect(dialog.contains(document.activeElement)).toBe(true);
    } else {
      // Fallback: at minimum focus should not escape to body
      expect(document.activeElement).not.toBe(document.body);
    }
  });
});
