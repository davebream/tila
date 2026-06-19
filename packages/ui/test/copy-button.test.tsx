import { CopyButton } from "@/components/ui/copy-button";
import { renderWithProviders, screen } from "./test-utils";

describe("CopyButton", () => {
  test("is perceivable at rest: opacity-40 not opacity-0", () => {
    renderWithProviders(<CopyButton value="hello-world" />);
    const btn = screen.getByRole("button", { name: "Copy hello-world" });
    expect(btn.className).not.toContain("opacity-0");
    expect(btn.className).toContain("opacity-40");
  });

  test("retains hover and focus-visible opacity classes", () => {
    renderWithProviders(<CopyButton value="hello-world" />);
    const btn = screen.getByRole("button", { name: "Copy hello-world" });
    expect(btn.className).toContain("group-hover/row:opacity-100");
    expect(btn.className).toContain("focus-visible:opacity-100");
    expect(btn.className).toContain("hover:opacity-100");
  });
});
