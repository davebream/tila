import { SettingsTransferPage } from "@/pages/settings-transfer";
import userEvent from "@testing-library/user-event";
import { executeSettingsTransfer } from "@tila/core";
import type { SettingsPlan, SettingsReceipt } from "@tila/schemas";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../mocks/server";
import { renderWithProviders, screen, waitFor } from "../test-utils";
const state = vi.hoisted(() => ({
  actor: "destination-person",
  download: vi.fn(),
  identity: vi.fn(),
  groups: vi.fn(),
  write: vi.fn(),
  preflight: vi.fn(),
}));
vi.mock("@/lib/definition-transfer", () => ({ downloadText: state.download }));
vi.mock("@/lib/settings-transfer", () => ({
  browserSettingsTransfer: (projectId: string) => ({
    read: {
      identity: state.identity,
      principals: async () => [state.actor],
      agents: async () => [],
      rooms: async () => [],
      groups: state.groups,
      definitions: async () => ({
        revision: 0,
        source: null,
        doc: null,
        appliedAt: null,
      }),
    },
    execute: (
      receipt: SettingsReceipt,
      persist: (r: SettingsReceipt) => void,
      options: { confirmRemovals: boolean },
    ) =>
      executeSettingsTransfer(
        { projectId, preflight: state.preflight, write: state.write },
        receipt,
        persist,
        options,
      ),
  }),
}));
const SOURCE = `[tila_export]
format = 'tila-project-settings'
format_version = 1
project_id = 'source'
exported_at = '2026-10-14T00:00:00.000Z'
[coverage.definitions]
status = 'omitted'
scope = 'visible'
[coverage.agents]
status = 'omitted'
scope = 'visible'
[coverage.rooms]
status = 'omitted'
scope = 'visible'
[coverage.signal_groups]
status = 'read'
scope = 'project'
[settings.signal_groups.sourcegroup]
name = 'Reviewers'
source_revision = 99
principal_ids = ['source-person']
`;
const key = "tila:settings-transfer:test-project:destination-person";
function render() {
  return renderWithProviders(<SettingsTransferPage />, {
    route: "/p/test-project/settings/transfer",
  });
}
async function prepare(
  user: ReturnType<typeof userEvent.setup>,
  source = SOURCE,
) {
  await waitFor(() =>
    expect(screen.getByLabelText("Or paste settings")).toBeEnabled(),
  );
  await user.click(await screen.findByLabelText("Or paste settings"));
  await user.paste(source);
  await user.click(
    screen.getByRole("button", { name: "Read file and choose mappings" }),
  );
  await user.selectOptions(
    await screen.findByLabelText("Destination for signal_groups sourcegroup"),
    "create",
  );
  await user.type(
    screen.getByLabelText("New destination ID for sourcegroup"),
    "reviewers",
  );
}
beforeEach(() => {
  state.actor = "destination-person";
  state.identity.mockReset();
  state.identity.mockImplementation(async () => ({
    ok: true,
    project_id: "test-project",
    principal_id: state.actor,
    auth_kind: "d1-token",
    scopes: "full",
    token_name: "fixture",
  }));
  state.groups.mockReset();
  state.groups.mockResolvedValue([]);
  server.use(
    http.get("*/api/whoami", async () =>
      HttpResponse.json(await state.identity()),
    ),
  );
  sessionStorage.clear();
  vi.clearAllMocks();
  state.preflight.mockResolvedValue(undefined);
  state.write.mockResolvedValue(10);
});
describe("Settings transfer", () => {
  it("offers labelled selections, blocks an unmapped identity and writes only the reviewed destination payload", async () => {
    const user = userEvent.setup();
    render();
    await prepare(user);
    await user.click(
      screen.getByRole("button", { name: "Preview complete import" }),
    );
    await waitFor(() =>
      expect(
        screen.getByLabelText("Destination for principal:source-person"),
      ).toHaveAttribute("aria-invalid", "true"),
    );
    expect(state.write).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(key)).toBeNull();
    await user.selectOptions(
      screen.getByLabelText("Destination for principal:source-person"),
      "destination-person",
    );
    await user.click(
      screen.getByRole("button", { name: "Preview complete import" }),
    );
    await screen.findByRole("button", { name: "Apply reviewed import" });
    const saved = JSON.parse(sessionStorage.getItem(key) ?? "{}");
    expect(saved.plan.actions[0].payload.principal_ids).toEqual([
      "destination-person",
    ]);
    expect(saved.plan.actions[0].expected_revision).toBe(0);
    await user.click(
      screen.getByRole("button", { name: "Apply reviewed import" }),
    );
    expect(
      await screen.findByText(/Settings transfer complete/),
    ).toBeInTheDocument();
    expect(state.write).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "group.set",
        resource_id: "reviewers",
        payload: { name: "Reviewers", principal_ids: ["destination-person"] },
      }),
      0,
    );
  });
  it("persists exact failed/committed outcomes across step-up/reload and retries only unresolved actions", async () => {
    const user = userEvent.setup();
    const view = render();
    await prepare(
      user,
      `${SOURCE}\n[settings.signal_groups.secondgroup]\nname='Dispatch'\nsource_revision=99\nprincipal_ids=['source-person']\n`,
    );
    await user.selectOptions(
      screen.getByLabelText("Destination for signal_groups secondgroup"),
      "create",
    );
    await user.type(
      screen.getByLabelText("New destination ID for secondgroup"),
      "dispatch",
    );
    await user.selectOptions(
      screen.getByLabelText("Destination for principal:source-person"),
      "drop",
    );
    await user.click(
      screen.getByRole("button", { name: "Preview complete import" }),
    );
    await screen.findByRole("button", { name: "Apply reviewed import" });
    const original = JSON.parse(sessionStorage.getItem(key) ?? "{}");
    state.write.mockResolvedValueOnce(10).mockRejectedValueOnce(
      Object.assign(new Error("Re-authenticate"), {
        code: "step-up-required",
        status: 403,
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Apply reviewed import" }),
    );
    await screen.findByText("Re-authenticate to continue");
    const partial = JSON.parse(sessionStorage.getItem(key) ?? "{}");
    expect(partial.plan).toEqual(original.plan);
    expect(partial.actions.map((a: { status: string }) => a.status)).toEqual([
      "committed",
      "failed",
    ]);
    view.unmount();
    render();
    await user.click(
      await screen.findByRole("button", { name: "Resume unresolved actions" }),
    );
    await screen.findByText(/Settings transfer complete/);
    expect(state.write.mock.calls[1]).toEqual(state.write.mock.calls[2]);
    expect(
      state.write.mock.calls.filter(
        ([a]) => a.id === original.plan.actions[0].id,
      ),
    ).toHaveLength(1);
    expect(
      JSON.parse(sessionStorage.getItem(key) ?? "{}").actions[0].status,
    ).toBe("committed");
  });
  it("does not apply when browser receipt persistence fails", async () => {
    const user = userEvent.setup();
    render();
    await prepare(user);
    await user.selectOptions(
      screen.getByLabelText("Destination for principal:source-person"),
      "drop",
    );
    const persist = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("storage unavailable");
      });
    try {
      await user.click(
        screen.getByRole("button", { name: "Preview complete import" }),
      );
      await screen.findByText(/The operation could not be completed/);
      expect(state.write).not.toHaveBeenCalled();
    } finally {
      persist.mockRestore();
    }
  });
});

async function retainedReceipt(actor = "destination-person") {
  const { createSettingsReceipt } = await import("@tila/core");
  const { SettingsPlanSchema } = await import("@tila/schemas");
  const operation = crypto.randomUUID();
  const c = { status: "omitted", scope: "visible", unavailable_fields: [] };
  const receipt = await createSettingsReceipt(
    SettingsPlanSchema.parse({
      format: "tila-settings-plan",
      version: 1,
      operation_id: operation,
      project_id: "test-project",
      creator_member: `principal:${actor}`,
      mappings: {
        identities: {},
        profiles: {},
        resources: { agents: {}, rooms: {}, signal_groups: {} },
      },
      references: [],
      removals: [],
      warnings: ["private A configuration"],
      coverage: { definitions: c, agents: c, rooms: c, signal_groups: c },
      actions: [
        {
          id: `${operation}:0`,
          kind: "group.set",
          resource_id: "private-group",
          expected_revision: 0,
          payload: { name: "Private A group", principal_ids: [actor] },
        },
        {
          id: `${operation}:1`,
          kind: "group.set",
          resource_id: "pending-group",
          expected_revision: 0,
          payload: { name: "Pending", principal_ids: [actor] },
        },
      ],
    }),
  );
  receipt.actions[0] = {
    action_id: receipt.actions[0].action_id,
    status: "committed",
    revision: 10,
    sent_revision: 0,
  };
  receipt.actions[1] = {
    action_id: receipt.actions[1].action_id,
    status: "failed",
    sent_revision: 0,
    error_code: "step-up-required",
  };
  return receipt;
}
function actorIdentity() {
  return {
    ok: true,
    project_id: "test-project",
    principal_id: state.actor,
    auth_kind: "d1-token",
    scopes: "full",
    token_name: "fixture",
  };
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Promise not initialized");
  };
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
it("hides account A's partial receipt from B, rejects B importing it, and restores A unchanged", async () => {
  const user = userEvent.setup();
  const receipt = await retainedReceipt();
  const saved = JSON.stringify(receipt);
  sessionStorage.setItem(key, saved);
  const a = render();
  await screen.findByText("private A configuration");
  a.unmount();
  state.actor = "different-person";
  const b = render();
  await waitFor(() =>
    expect(screen.getByLabelText("Load a resume receipt")).toBeEnabled(),
  );
  expect(screen.queryByText("private A configuration")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Download resume receipt" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Start a new review" }),
  ).not.toBeInTheDocument();
  const upload = new File([saved], "a-receipt.json", {
    type: "application/json",
  });
  await user.upload(screen.getByLabelText("Load a resume receipt"), upload);
  await screen.findByText(/The operation could not be completed/);
  expect(sessionStorage.getItem(key)).toBe(saved);
  expect(
    sessionStorage.getItem(
      "tila:settings-transfer:test-project:different-person",
    ),
  ).toBeNull();
  expect(state.write).not.toHaveBeenCalled();
  b.unmount();
  state.actor = "destination-person";
  render();
  await screen.findByText("private A configuration");
  expect(sessionStorage.getItem(key)).toBe(saved);
  await user.click(
    screen.getByRole("button", { name: "Resume unresolved actions" }),
  );
  await screen.findByText(/Settings transfer complete/);
  expect(state.write).toHaveBeenCalledTimes(1);
  expect(state.write.mock.calls[0][0].id).toBe(receipt.plan.actions[1].id);
});
it("locks every mapping/strategy control while inspecting and discards an account-superseded preview", async () => {
  const user = userEvent.setup();
  const view = render();
  await prepare(user);
  await user.selectOptions(
    screen.getByLabelText("Destination for principal:source-person"),
    "drop",
  );
  const held = deferred<[]>();
  state.groups.mockImplementationOnce(() => held.promise);
  await user.click(
    screen.getByRole("button", { name: "Preview complete import" }),
  );
  await waitFor(() =>
    expect(
      screen.getByLabelText("Destination for principal:source-person"),
    ).toBeDisabled(),
  );
  expect(
    screen.getByLabelText("Destination for signal_groups sourcegroup"),
  ).toBeDisabled();
  expect(
    screen.getByLabelText("New destination ID for sourcegroup"),
  ).toBeDisabled();
  expect(screen.getByLabelText("Or paste settings")).toBeDisabled();
  state.actor = "different-person";
  view.queryClient.setQueryData(["whoami", "test-project"], actorIdentity());
  await waitFor(() =>
    expect(screen.getByLabelText("Or paste settings")).toHaveValue(""),
  );
  held.resolve([]);
  await waitFor(() =>
    expect(screen.getByLabelText("Or paste settings")).toBeEnabled(),
  );
  expect(sessionStorage.getItem(key)).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Apply reviewed import" }),
  ).not.toBeInTheDocument();
  expect(state.write).not.toHaveBeenCalled();
});
it("does not publish old account identities/resources after a delayed source load", async () => {
  const user = userEvent.setup();
  const view = render();
  await waitFor(() =>
    expect(screen.getByLabelText("Or paste settings")).toBeEnabled(),
  );
  await user.click(screen.getByLabelText("Or paste settings"));
  await user.paste(SOURCE);
  const held = deferred<[]>();
  state.groups.mockImplementationOnce(() => held.promise);
  await user.click(
    screen.getByRole("button", { name: "Read file and choose mappings" }),
  );
  await waitFor(() => expect(state.groups).toHaveBeenCalled());
  state.actor = "different-person";
  view.queryClient.setQueryData(["whoami", "test-project"], actorIdentity());
  await waitFor(() =>
    expect(screen.getByLabelText("Or paste settings")).toHaveValue(""),
  );
  held.resolve([]);
  await waitFor(() =>
    expect(screen.getByLabelText("Or paste settings")).toBeEnabled(),
  );
  expect(
    screen.queryByLabelText("Destination for principal:source-person"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText(/Some destination lists are unavailable/),
  ).not.toBeInTheDocument();
  expect(sessionStorage.getItem(key)).toBeNull();
});
it("waits for delayed restoration before accepting a receipt import", async () => {
  const receipt = await retainedReceipt();
  const saved = JSON.stringify(receipt);
  sessionStorage.setItem(key, saved);
  const original = crypto.subtle.digest.bind(crypto.subtle);
  const held = deferred<ArrayBuffer>();
  let started = false;
  const hashing = vi
    .spyOn(crypto.subtle, "digest")
    .mockImplementationOnce(() => {
      started = true;
      return held.promise;
    });
  try {
    render();
    await waitFor(() => expect(started).toBe(true));
    expect(screen.getByLabelText("Load a resume receipt")).toBeDisabled();
    expect(
      screen.queryByText("private A configuration"),
    ).not.toBeInTheDocument();
    const { canonicalSettingsJson } = await import("@tila/core");
    held.resolve(
      await original(
        "SHA-256",
        new TextEncoder().encode(canonicalSettingsJson(receipt.plan)),
      ),
    );
    await screen.findByText("private A configuration");
    expect(sessionStorage.getItem(key)).toBe(saved);
    expect(state.write).not.toHaveBeenCalled();
  } finally {
    hashing.mockRestore();
  }
});
it("requires explicit confirmation of reviewed recipient removals", async () => {
  state.groups.mockResolvedValue([
    {
      id: "reviewers",
      name: "Existing reviewers",
      principal_ids: ["old-person"],
      revision: 7,
      created_at: 1,
      updated_at: 1,
    },
  ]);
  const user = userEvent.setup();
  render();
  await waitFor(() =>
    expect(screen.getByLabelText("Or paste settings")).toBeEnabled(),
  );
  await user.click(screen.getByLabelText("Or paste settings"));
  await user.paste(SOURCE);
  await user.click(
    screen.getByRole("button", { name: "Read file and choose mappings" }),
  );
  await user.selectOptions(
    await screen.findByLabelText("Destination for signal_groups sourcegroup"),
    "update:reviewers",
  );
  await user.selectOptions(
    screen.getByLabelText("Destination for principal:source-person"),
    "drop",
  );
  await user.click(
    screen.getByRole("button", { name: "Preview complete import" }),
  );
  const apply = await screen.findByRole("button", {
    name: "Apply reviewed import",
  });
  expect(apply).toBeDisabled();
  expect(
    screen.getByText("group:reviewers recipient principal:old-person"),
  ).toBeInTheDocument();
  await user.click(
    screen.getByLabelText(
      "Confirm every listed grant/member/recipient removal",
    ),
  );
  await user.click(apply);
  await screen.findByText(/Settings transfer complete/);
  expect(state.write.mock.calls[0][1]).toBe(7);
});
it("discards old-account export downloads and notices when the export read is delayed", async () => {
  const user = userEvent.setup();
  const view = render();
  await waitFor(() =>
    expect(screen.getByLabelText("Or paste settings")).toBeEnabled(),
  );
  const held = deferred<[]>();
  state.groups.mockImplementationOnce(() => held.promise);
  await user.click(
    screen.getByRole("button", { name: "Export selected settings" }),
  );
  await waitFor(() => expect(state.groups).toHaveBeenCalled());
  state.actor = "different-person";
  view.queryClient.setQueryData(["whoami", "test-project"], actorIdentity());
  await waitFor(() =>
    expect(screen.getByLabelText("Or paste settings")).toBeEnabled(),
  );
  held.resolve([]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(state.download).not.toHaveBeenCalled();
  expect(screen.queryByText(/Export coverage:/)).not.toBeInTheDocument();
});
