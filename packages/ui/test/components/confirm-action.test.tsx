import { ConfirmAction } from "@/components/ui/confirm-action";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "../test-utils";

describe("ConfirmAction", () => {
  test("enables the destructive button only once the typed name matches", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderWithProviders(
      <ConfirmAction
        open
        onOpenChange={() => {}}
        title="Revoke credential"
        description="Irreversible."
        confirmText="ci-token"
        confirmLabel="Revoke"
        onConfirm={onConfirm}
      />,
    );

    const confirm = screen.getByRole("button", { name: "Revoke" });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByRole("textbox"), "ci-tok");
    expect(confirm).toBeDisabled();
    await user.type(screen.getByRole("textbox"), "en");
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test("without confirmText the action is immediately available and shows errors", () => {
    renderWithProviders(
      <ConfirmAction
        open
        onOpenChange={() => {}}
        title="Revoke membership"
        description="Irreversible."
        error="Cannot revoke the last owner"
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Confirm" })).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Cannot revoke the last owner",
    );
  });
});
