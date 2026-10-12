import { DevicePage, HandoffPage } from "@/pages/account-access";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { renderWithProviders, screen, waitFor } from "../test-utils";

test("requires confirmation of the target account before consuming a browser link", async () => {
  window.history.replaceState(null, "", `/#${"a".repeat(64)}`);
  const consume = vi.fn(() =>
    HttpResponse.json(
      { message: "Link expired or already used" },
      { status: 401 },
    ),
  );
  server.use(
    http.post("*/api/account/handoff/inspect", () =>
      HttpResponse.json({ email: "person@example.com" }),
    ),
    http.post("*/api/account/auth/handoff/consume", consume),
  );
  renderWithProviders(<HandoffPage />, { authenticated: false });
  expect(
    await screen.findByText("Sign in as person@example.com"),
  ).toBeInTheDocument();
  expect(window.location.hash).toBe("");
  expect(consume).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole("button", { name: "Continue to tila" }),
  );
  await waitFor(() => expect(consume).toHaveBeenCalledOnce());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Link expired or already used",
  );
});

test("shows the requesting device and requires a separate approval action", async () => {
  const approve = vi.fn(async ({ request }: { request: Request }) => {
    expect(await request.json()).toEqual({ userCode: "ABCD1234" });
    return HttpResponse.json({ ok: true });
  });
  server.use(
    http.get("*/api/account/auth/device", () =>
      HttpResponse.json({ client_id: "tila-cli:My laptop" }),
    ),
    http.post("*/api/account/auth/device/approve", approve),
  );
  renderWithProviders(<DevicePage />, { route: "/device?user_code=ABCD1234" });
  expect(approve).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Check device" }));
  expect(await screen.findByText("Device: My laptop")).toBeInTheDocument();
  expect(approve).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Approve device" }));
  expect(
    await screen.findByText(/You can return to your terminal/),
  ).toBeInTheDocument();
});

test("clears the previous account's cached data after a successful handoff", async () => {
  window.history.replaceState(null, "", `/#${"b".repeat(64)}`);
  server.use(
    http.post("*/api/account/handoff/inspect", () =>
      HttpResponse.json({ email: "next@example.com" }),
    ),
    http.post("*/api/account/auth/handoff/consume", () =>
      HttpResponse.json({ ok: true }),
    ),
  );
  const { queryClient } = renderWithProviders(<HandoffPage />);
  queryClient.setQueryData(["private-project-records"], {
    owner: "previous-account",
  });
  await screen.findByText("Sign in as next@example.com");
  await userEvent.click(
    screen.getByRole("button", { name: "Continue to tila" }),
  );
  await waitFor(() =>
    expect(
      queryClient.getQueryData(["private-project-records"]),
    ).toBeUndefined(),
  );
});
