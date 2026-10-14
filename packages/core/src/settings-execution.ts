import {
  type Agent,
  type AgentRegistration,
  type CreateRoom,
  type Room,
  type SchemaApplyResponse,
  type SchemaGetResponse,
  type SetSignalGroupRequest,
  type SettingsAction,
  type SettingsActionReceipt,
  type SettingsPlan,
  SettingsPlanSchema,
  type SettingsReceipt,
  SettingsReceiptSchema,
  type SignalGroup,
  type UpdateAgent,
  type UpdateRoom,
  type WhoamiResponse,
} from "@tila/schemas";

/** Portable JSON normalization also defines the reviewed plan's digest. */
export function canonicalSettingsJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalSettingsJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => compareSettingsKeys(a, b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalSettingsJson(v)}`)
    .join(",")}}`;
}

/** Unicode code-point order, independent of the caller's host locale. */
export function compareSettingsKeys(left: string, right: string): number {
  const a = Array.from(left, (c) => c.codePointAt(0) ?? 0);
  const b = Array.from(right, (c) => c.codePointAt(0) ?? 0);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}
async function digest(plan: SettingsPlan) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalSettingsJson(plan)),
  );
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/** Receipts contain reviewed payloads, never credentials or transport diagnostics. */
function safeArtifact(value: unknown): void {
  const secret =
    /(?:tila_d1_[0-9a-f]{72}|tila_u_[A-Za-z0-9._~-]{16,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}|-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----|\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}|\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/;
  if (typeof value === "string" && secret.test(value))
    fail(
      "forbidden-secret",
      "A transfer artifact contains a credential-shaped value.",
    );
  if (value && typeof value === "object")
    for (const item of Object.values(value)) safeArtifact(item);
}
export function validateSettingsPlan(raw: unknown): SettingsPlan {
  const plan = SettingsPlanSchema.parse(raw);
  safeArtifact(plan);
  const seen = new Map<string, SettingsAction>();
  const stages: Record<SettingsAction["kind"], number> = {
    definitions: 0,
    "agent.create": 1,
    "agent.update": 1,
    "room.create": 2,
    "room.update": 2,
    "room.member": 2,
    "group.set": 3,
  };
  let stage = 0;
  for (const ref of plan.references)
    if (!Object.hasOwn(plan.mappings.identities, ref))
      fail(
        "unmapped-reference",
        "The frozen plan contains an unresolved identity.",
      );
  for (const [index, a] of plan.actions.entries()) {
    if (a.id !== `${plan.operation_id}:${index}` || seen.has(a.id))
      fail("invalid-plan", "Action IDs do not match the frozen operation.");
    if (stages[a.kind] < stage)
      fail("invalid-plan", "Actions are out of dependency order.");
    stage = stages[a.kind];
    if (a.kind.endsWith(".create")) {
      if (
        a.expected_revision !== undefined ||
        a.revision_from !== undefined ||
        !("id" in a.payload) ||
        a.payload.id !== a.resource_id
      )
        fail("invalid-plan", "Invalid create precondition.");
    } else {
      if (
        (a.expected_revision !== undefined) ===
        (a.revision_from !== undefined)
      )
        fail(
          "invalid-plan",
          "Every mutation needs exactly one reviewed revision.",
        );
      if (a.revision_from) {
        const before = seen.get(a.revision_from);
        if (
          !before ||
          before.resource_id !== a.resource_id ||
          before.kind.split(".")[0] !== a.kind.split(".")[0]
        )
          fail("invalid-plan", "Invalid revision dependency.");
      } else if (
        a.expected_revision === 0 &&
        a.kind !== "definitions" &&
        a.kind !== "group.set"
      )
        fail("invalid-plan", "A resource update needs a positive revision.");
    }
    seen.set(a.id, a);
  }
  return plan;
}
export async function createSettingsReceipt(
  raw: SettingsPlan,
): Promise<SettingsReceipt> {
  const plan = validateSettingsPlan(raw);
  return {
    format: "tila-settings-receipt",
    version: 1,
    plan,
    plan_sha256: await digest(plan),
    actions: plan.actions.map((a) => ({
      action_id: a.id,
      status: "not-attempted",
    })),
  };
}
export async function validateSettingsReceipt(
  raw: unknown,
  projectId: string,
): Promise<SettingsReceipt> {
  const receipt = SettingsReceiptSchema.parse(raw);
  validateSettingsPlan(receipt.plan);
  if (receipt.plan.project_id !== projectId)
    fail(
      "project-mismatch",
      "The receipt belongs to another destination project.",
    );
  if ((await digest(receipt.plan)) !== receipt.plan_sha256)
    fail("plan-mismatch", "The frozen plan changed. Review a new plan.");
  if (receipt.actions.length !== receipt.plan.actions.length)
    fail("receipt-mismatch", "Receipt action count differs from the plan.");
  let unresolved = false;
  for (const [i, r] of receipt.actions.entries()) {
    if (r.action_id !== receipt.plan.actions[i].id)
      fail("receipt-mismatch", "Receipt action order differs from the plan.");
    if (r.status === "committed") {
      if (unresolved || r.revision === undefined)
        fail(
          "receipt-mismatch",
          "Committed actions must be a prefix with revisions.",
        );
    } else unresolved = true;
    const a = receipt.plan.actions[i];
    const expected = a.revision_from
      ? receipt.actions.find((r) => r.action_id === a.revision_from)?.revision
      : a.expected_revision;
    if (r.sent_revision !== undefined && r.sent_revision !== expected)
      fail(
        "receipt-mismatch",
        "The sent revision differs from the frozen revision chain.",
      );
  }
  return receipt;
}
export type SettingsExecutionPort = {
  projectId: string;
  /** Current read/access validation only; never rebase or replace the plan. */
  preflight(plan: SettingsPlan): Promise<void>;
  /** Existing authorized service operation, including authorized replay. */
  write(
    action: SettingsAction,
    expectedRevision: number | undefined,
  ): Promise<number>;
};
export type SettingsPersist = (
  receipt: SettingsReceipt,
) => Promise<void> | void;

/** Stop at failure, preserve successes, and retry only unresolved exact requests. */
export async function executeSettingsTransfer(
  port: SettingsExecutionPort,
  raw: SettingsReceipt,
  persist: SettingsPersist,
  options: { confirmRemovals?: boolean } = {},
): Promise<SettingsReceipt> {
  const receipt = await validateSettingsReceipt(raw, port.projectId);
  if (receipt.plan.removals.length && !options.confirmRemovals)
    fail(
      "removals-not-confirmed",
      "Confirm every listed grant/member/recipient removal before applying.",
    );
  // Persist before any call that could mutate. A failed save means zero writes.
  const save = () => persist(structuredClone(receipt));
  await save();
  await port.preflight(receipt.plan);
  for (const [index, action] of receipt.plan.actions.entries()) {
    const state = receipt.actions[index];
    if (state.status === "committed") continue;
    const expected = action.revision_from
      ? receipt.actions.find((r) => r.action_id === action.revision_from)
          ?.revision
      : action.expected_revision;
    if (action.revision_from && expected === undefined)
      fail("receipt-mismatch", "Preceding action has no committed revision.");
    if (state.sent_revision !== undefined && state.sent_revision !== expected)
      fail(
        "receipt-mismatch",
        "Retry would change the original payload revision.",
      );
    const before: SettingsActionReceipt = {
      action_id: action.id,
      status: "uncertain",
      ...(expected !== undefined ? { sent_revision: expected } : {}),
    };
    receipt.actions[index] = before;
    await save();
    try {
      const revision = await port.write(action, expected);
      if (!Number.isSafeInteger(revision) || revision < 0)
        fail("revision-unavailable", "The service did not confirm a revision.");
      receipt.actions[index] = { ...before, status: "committed", revision };
    } catch (err) {
      const e = err as { status?: number; statusCode?: number; code?: string };
      const status = e.status ?? e.statusCode;
      // No response or 5xx may have committed. Never call it a definite failure.
      const ambiguous =
        e.code === "create-ambiguous" || e.code === "revision-unavailable";
      receipt.actions[index] = {
        ...before,
        status:
          !ambiguous && status !== undefined && status >= 400 && status < 500
            ? "failed"
            : "uncertain",
        error_code:
          e.code && /^[a-zA-Z0-9._-]{1,80}$/.test(e.code)
            ? e.code
            : "unconfirmed",
      };
      await save();
      return receipt;
    }
    // If this save fails, the last durable receipt is uncertain and can replay.
    await save();
  }
  return receipt;
}

/** Service seam shared by the SDK and dashboard; adapters carry no domain decisions. */
export type SettingsServices = {
  identity(): Promise<WhoamiResponse>;
  principals(): Promise<string[]>;
  agent(id: string): Promise<Agent>;
  room(
    id: string,
  ): Promise<{ room: Room; members?: { member: string; wake: boolean }[] }>;
  group(id: string): Promise<SignalGroup>;
  definitions(): Promise<SchemaGetResponse>;
  applyDefinitions(
    definition: string,
    strategy: "relax" | "force" | undefined,
    options: {
      expected_revision?: number;
      reviewed_definition: string;
      idempotency_key: string;
    },
  ): Promise<SchemaApplyResponse>;
  createAgent(input: AgentRegistration): Promise<Agent>;
  updateAgent(
    id: string,
    input: UpdateAgent,
    key: { idempotencyKey: string },
  ): Promise<Agent>;
  createRoom(input: CreateRoom): Promise<unknown>;
  updateRoom(
    id: string,
    input: UpdateRoom,
    key: { idempotencyKey: string },
  ): Promise<Room>;
  setMember(
    id: string,
    member: string,
    wake: boolean,
    options: { idempotencyKey: string; expectedRevision?: number },
  ): Promise<Room | undefined>;
  removeMember(
    id: string,
    member: string,
    options: { idempotencyKey: string; expectedRevision?: number },
  ): Promise<Room | undefined>;
  setGroup(
    id: string,
    input: SetSignalGroupRequest,
    options: { idempotencyKey: string },
  ): Promise<SignalGroup>;
};
export function createSettingsExecutionPort(
  projectId: string,
  services: SettingsServices,
): SettingsExecutionPort {
  const same = (a: unknown, b: unknown) =>
    canonicalSettingsJson(a) === canonicalSettingsJson(b);
  const fail = (code: string, message: string): never => {
    throw Object.assign(new Error(message), { code, status: 409 });
  };
  return {
    projectId,
    async preflight(plan: SettingsPlan) {
      const identity = await services.identity();
      if (
        identity.project_id !== projectId ||
        !identity.principal_id ||
        plan.creator_member !== `principal:${identity.principal_id}`
      )
        fail(
          "identity-mismatch",
          "Resume with the original destination identity.",
        );
      const full =
        identity.auth_kind === "d1-token" &&
        identity.scopes === "full" &&
        !identity.policy;
      const manage =
        full || identity.role === "owner" || identity.role === "maintainer";
      const capabilities: Record<string, string[]> = {
        definitions: ["schema:read", "schema:preview", "schema:write"],
        agent: ["agents:read", "agents:manage"],
        room: ["conversations:read", "conversations:manage"],
        group: ["signals:read", "signals:manage"],
      };
      for (const kind of new Set(plan.actions.map((a) => a.kind.split(".")[0])))
        if (
          !manage ||
          (!full &&
            capabilities[kind].some(
              (cap) => !identity.policy?.capabilities.includes(cap as never),
            ))
        )
          fail(
            "permission-denied",
            "Current destination permission does not allow this transfer.",
          );
      const principalTargets = Object.entries(plan.mappings.identities)
        .filter(([key, v]) => key.startsWith("principal:") && "target" in v)
        .map(([, v]) => ("target" in v ? v.target : ""));
      const principals = principalTargets.some(
        (id) => id !== identity.principal_id,
      )
        ? await services.principals()
        : [identity.principal_id];
      for (const id of principalTargets)
        if (!principals.includes(id))
          fail(
            "unknown-target",
            "A mapped principal is no longer readable in the destination.",
          );
      const creates = new Set(
        plan.actions
          .filter((a) => a.kind === "agent.create")
          .map((a) => a.resource_id),
      );
      for (const [ref, choice] of Object.entries(plan.mappings.identities))
        if (
          ref.startsWith("agent:") &&
          "target" in choice &&
          !creates.has(choice.target)
        ) {
          const agent = await services.agent(choice.target);
          if (agent.archived)
            fail("agent-archived", "A mapped destination agent is archived.");
        }
      for (const action of plan.actions) {
        if (action.kind === "agent.update" && !creates.has(action.resource_id))
          await services.agent(action.resource_id);
        if (
          (action.kind === "room.update" || action.kind === "room.member") &&
          !plan.actions.some(
            (a) =>
              a.kind === "room.create" && a.resource_id === action.resource_id,
          )
        )
          await services.room(action.resource_id);
        if (action.kind === "group.set" && action.expected_revision !== 0)
          await services.group(action.resource_id);
        if (action.kind === "definitions") await services.definitions();
      }
    },
    async write(action, expected) {
      const key = { idempotencyKey: action.id };
      switch (action.kind) {
        case "definitions": {
          const result = await services.applyDefinitions(
            action.payload.definition,
            action.payload.strategy,
            {
              expected_revision: expected,
              reviewed_definition: action.payload.definition,
              idempotency_key: action.id,
            },
          );
          if (!result.ok)
            fail("schema-apply-failed", "Definitions were not applied.");
          return (
            result.revision ??
            result.version ??
            fail(
              "revision-unavailable",
              "The server did not return the definition revision.",
            )
          );
        }
        case "agent.create": {
          // Register has stable-ID/owner/settings reconciliation, not general
          // idempotency receipts. Never invent unsupported write options.
          const result = await services.createAgent(action.payload);
          const agent = result;
          if (
            agent.archived ||
            agent.name !== action.payload.name ||
            !same(agent.bind_policy, action.payload.bind_policy) ||
            agent.profile_selection !== null
          )
            fail(
              "create-ambiguous",
              "Created agent differs from the exact reviewed initial state; inspect before retry.",
            );
          return agent.revision;
        }
        case "agent.update":
          return (
            await services.updateAgent(
              action.resource_id,
              { ...action.payload, expected_revision: expected as number },
              key,
            )
          ).revision;
        case "room.create": {
          await services.createRoom(action.payload);
          const result = await services.room(action.resource_id);
          const { room, members } = result;
          const config = {
            id: room.id,
            name: room.name,
            history_policy: room.history_policy,
            delivery_ttl_seconds: room.delivery_ttl_seconds,
            budgets: room.budgets,
          };
          if (
            room.archived ||
            !same(config, action.payload) ||
            !members ||
            members.length !== 1 ||
            members[0].member !==
              `principal:${(await services.identity()).principal_id}` ||
            members[0].wake !== false
          )
            fail(
              "create-ambiguous",
              "Created room differs from its reviewed initial configuration or creator membership; inspect before retry.",
            );
          return room.revision;
        }
        case "room.update":
          return (
            await services.updateRoom(
              action.resource_id,
              { ...action.payload, expected_revision: expected as number },
              key,
            )
          ).revision;
        case "room.member": {
          const write = { ...key, expectedRevision: expected };
          const result =
            action.payload.wake === null
              ? await services.removeMember(
                  action.resource_id,
                  action.payload.member,
                  write,
                )
              : await services.setMember(
                  action.resource_id,
                  action.payload.member,
                  action.payload.wake,
                  write,
                );
          return (
            result?.revision ??
            fail(
              "revision-unavailable",
              "The server did not return the committed room revision.",
            )
          );
        }
        case "group.set":
          return (
            await services.setGroup(
              action.resource_id,
              { ...action.payload, expected_revision: expected },
              key,
            )
          ).revision;
      }
    },
  };
}
