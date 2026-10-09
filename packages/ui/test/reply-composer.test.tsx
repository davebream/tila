import { ReplyComposer } from "@/components/reply-composer";
import { draftKey, loadDraft } from "@/lib/conversation-draft";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "./mocks/server";
import { renderWithProviders, screen, waitFor } from "./test-utils";

const key = draftKey("person-one", "test-project", "general", null);
const props = {
  project: "test-project",
  room: "general",
  thread: null,
  storageKey: key,
  onPublished: vi.fn(),
};
beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
});

test("retries the same publication after a lost response without clearing newer edits", async () => {
  const calls: { body: string; client_op_id: string }[] = [];
  let finish: (() => void) | undefined;
  server.use(
    http.post(
      "*/projects/test-project/rooms/general/messages",
      async ({ request }) => {
        expect(request.headers.has("Idempotency-Key")).toBe(false);
        expect(request.headers.get("X-Tila-Conversation-Protocol")).toBe("1");
        calls.push((await request.json()) as (typeof calls)[number]);
        if (calls.length === 1) return HttpResponse.error();
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return HttpResponse.json({ ok: true });
      },
    ),
  );
  renderWithProviders(<ReplyComposer {...props} />);
  const user = userEvent.setup();
  const input = screen.getByRole("textbox", { name: "Reply to room" });
  await user.type(input, "original");
  await user.click(screen.getByRole("button", { name: "Send reply" }));
  await waitFor(() => expect(calls).toHaveLength(2));
  await user.clear(input);
  await user.type(input, "new draft");
  finish?.();
  await screen.findByText("Reply published.");
  expect(calls[0]).toEqual(calls[1]);
  expect(input).toHaveValue("new draft");
  expect(loadDraft(key).body).toBe("new draft");
  expect(loadDraft(key).pending).toBeNull();
});

test("restores the exact pending reply across step-up reload and isolates another principal", async () => {
  const calls: unknown[] = [];
  server.use(
    http.post(
      "*/projects/test-project/rooms/general/messages",
      async ({ request }) => {
        calls.push(await request.json());
        return calls.length === 1
          ? HttpResponse.json(
              { error: { code: "step-up-required", message: "Sign in" } },
              { status: 403 },
            )
          : HttpResponse.json({ ok: true });
      },
    ),
  );
  const user = userEvent.setup();
  const first = renderWithProviders(<ReplyComposer {...props} />);
  await user.type(screen.getByRole("textbox"), "preserved reply");
  await user.click(screen.getByRole("button", { name: "Send reply" }));
  await screen.findByText("Re-authenticate to continue");
  first.unmount();
  expect(
    loadDraft(draftKey("person-two", "test-project", "general", null)).body,
  ).toBe("");
  renderWithProviders(<ReplyComposer {...props} />);
  expect(screen.getByRole("textbox")).toHaveValue("preserved reply");
  await user.click(screen.getByRole("button", { name: "Retry saved reply" }));
  await screen.findByText("Reply published.");
  expect(calls[0]).toEqual(calls[1]);
  expect(screen.getByRole("textbox")).toHaveValue("");
});

test("a response from an unmounted composer preserves the reopened draft", async () => {
  let finish: (() => void) | undefined;
  server.use(
    http.post("*/projects/test-project/rooms/general/messages", async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return HttpResponse.json({ ok: true });
    }),
  );
  const user = userEvent.setup();
  const first = renderWithProviders(<ReplyComposer {...props} />);
  await user.type(screen.getByRole("textbox"), "first reply");
  await user.click(screen.getByRole("button", { name: "Send reply" }));
  await waitFor(() => expect(finish).toBeDefined());
  first.unmount();
  renderWithProviders(<ReplyComposer {...props} />);
  await user.clear(screen.getByRole("textbox"));
  await user.type(screen.getByRole("textbox"), "newer reopened draft");
  finish?.();
  await waitFor(() => expect(props.onPublished).toHaveBeenCalled());
  expect(loadDraft(key).body).toBe("newer reopened draft");
  expect(loadDraft(key).pending).toBeNull();
});
