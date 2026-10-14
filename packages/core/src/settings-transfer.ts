import {
  type Agent,
  AgentRegistrationSchema,
  CreateRoomSchema,
  type Room,
  SETTINGS_TRANSFER_MAX_BYTES,
  type SettingsAction,
  type SettingsDocument,
  SettingsDocumentSchema,
  type SettingsMappings,
  SettingsMappingsSchema,
  type SettingsPlan,
  SettingsPlanSchema,
  type SettingsSection,
  type SignalGroup,
  type WhoamiResponse,
} from "@tila/schemas";
import {
  type DefinitionFormat,
  definitionFormatFromName,
  findForbiddenDefinitionContent,
  planDefinitionImport,
} from "./definition-transfer";
import {
  type CurrentDefinition,
  currentDefinition,
  parseDefinitionDocument,
  serializeDefinitionDocument,
} from "./schema-document";
import {
  canonicalSettingsJson,
  compareSettingsKeys,
} from "./settings-execution";

export type SettingsError = { code: string; path?: string; message: string };
export type SettingsResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: SettingsError[] };
const error = (
  code: string,
  message: string,
  path?: string,
): SettingsError => ({ code, message, ...(path ? { path } : {}) });
const same = (a: unknown, b: unknown) =>
  canonicalSettingsJson(a) === canonicalSettingsJson(b);
const own = (o: object, key: string) => Object.hasOwn(o, key);
const sorted = <T>(o: Record<string, T>) =>
  Object.entries(o).sort(([a], [b]) => compareSettingsKeys(a, b));

/** Strict envelope, allowlisted fields and diagnostics that never echo values. */
export function readSettingsTree(
  tree: unknown,
): SettingsResult<SettingsDocument> {
  const parsed = SettingsDocumentSchema.safeParse(tree);
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.map((i) =>
        error(
          "settings-format",
          "Invalid or unsupported settings field.",
          i.path.join("."),
        ),
      ),
    };
  const doc = parsed.data;
  const forbidden = findForbiddenDefinitionContent({
    settings: doc.settings,
    definitions: doc.definitions ?? {},
  });
  if (forbidden.length) return { ok: false, errors: forbidden };
  const errors: SettingsError[] = [];
  for (const section of [
    "definitions",
    "agents",
    "rooms",
    "signal_groups",
  ] as const) {
    const present =
      section === "definitions"
        ? doc.definitions !== undefined
        : doc.settings[section] !== undefined;
    if (present !== (doc.coverage[section].status === "read"))
      errors.push(
        error(
          "coverage-mismatch",
          "Read coverage must match the included section.",
          section,
        ),
      );
    if (doc.coverage[section].status === "failed")
      errors.push(
        error(
          "export-incomplete",
          "A failed read cannot be exported as a settings document.",
          section,
        ),
      );
  }
  for (const [id, agent] of Object.entries(doc.settings.agents ?? {})) {
    for (const field of ["bind_policy", "profile"] as const) {
      const hidden = doc.coverage.agents.unavailable_fields.includes(
        `${id}.${field}`,
      );
      if (hidden === (agent[field] !== undefined))
        errors.push(
          error(
            "coverage-mismatch",
            "Hidden fields must be unavailable, never empty replacements.",
            `agents.${id}.${field}`,
          ),
        );
    }
  }
  for (const [id, room] of Object.entries(doc.settings.rooms ?? {})) {
    const hidden = doc.coverage.rooms.unavailable_fields.includes(
      `${id}.members`,
    );
    if (hidden === (room.members !== undefined))
      errors.push(
        error(
          "coverage-mismatch",
          "Member coverage must match the included field.",
          `rooms.${id}.members`,
        ),
      );
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: doc };
}

export function readTomlSettings(
  text: string,
): SettingsResult<SettingsDocument> {
  if (new TextEncoder().encode(text).length > SETTINGS_TRANSFER_MAX_BYTES)
    return {
      ok: false,
      errors: [error("too-large", "The settings file is too large.")],
    };
  const parsed = parseDefinitionDocument(text);
  return parsed.ok
    ? readSettingsTree(parsed.doc)
    : {
        ok: false,
        errors: [error("syntax", "Invalid TOML settings document.")],
      };
}
export function settingsFormat(filename: string): DefinitionFormat {
  const format = definitionFormatFromName(filename);
  if (typeof format !== "string")
    throw Object.assign(new Error("Use a TOML or YAML settings file."), {
      code: "unsupported-format",
    });
  return format;
}
export function renderTomlSettings(input: SettingsDocument): string {
  const parsed = readSettingsTree(input);
  if (!parsed.ok)
    throw Object.assign(new Error("Settings export validation failed."), {
      code: parsed.errors[0].code,
    });
  const text = `# Portable settings; caller-scoped coverage. Not a backup.\n${serializeDefinitionDocument(parsed.value)}`;
  if (new TextEncoder().encode(text).length > SETTINGS_TRANSFER_MAX_BYTES)
    throw Object.assign(new Error("The settings export is too large."), {
      code: "too-large",
    });
  return text;
}

export type SettingsRights = {
  principal: string;
  creatorMember: string;
  agents: boolean;
  rooms: boolean;
  signal_groups: boolean;
  definitions: boolean;
  agentDetails: boolean;
};
/** Evidence only. Every server operation checks authority again. */
export function settingsRights(
  identity: WhoamiResponse,
  project: string,
): SettingsRights {
  const scoped = identity.project_id === project;
  const full =
    scoped &&
    identity.auth_kind === "d1-token" &&
    identity.scopes === "full" &&
    !identity.policy;
  const manager =
    scoped &&
    (full || identity.role === "owner" || identity.role === "maintainer");
  const has = (cap: string) =>
    full || !!identity.policy?.capabilities.includes(cap as never);
  const principal = scoped ? (identity.principal_id ?? "") : "";
  return {
    principal,
    creatorMember: `principal:${principal}`,
    agents: manager && has("agents:manage"),
    rooms: manager && has("conversations:manage"),
    signal_groups: manager && has("signals:manage"),
    definitions: manager && has("schema:write") && has("schema:preview"),
    agentDetails: manager && has("agents:manage"),
  };
}

export type SettingsSnapshot = {
  projectId: string;
  rights: SettingsRights;
  principals: string[];
  agents: Record<string, Agent>;
  rooms: Record<
    string,
    { room: Room; members: { member: string; wake: boolean }[] }
  >;
  signal_groups: Record<string, SignalGroup>;
  definitions: CurrentDefinition | null;
  // Successfully read lists; hidden resources are never inferred absent.
  readable: SettingsSection[];
  verifiedProfiles: Agent["profile_selection"][];
};
export type SettingsReadPort = {
  identity(): Promise<WhoamiResponse>;
  principals(): Promise<string[]>;
  agents(includeArchived: boolean): Promise<Agent[]>;
  rooms(includeArchived: boolean): Promise<Room[]>;
  room(
    id: string,
  ): Promise<{ room: Room; members?: { member: string; wake: boolean }[] }>;
  groups(): Promise<SignalGroup[]>;
  definitions(): Promise<CurrentDefinition>;
  // Implement only with an actual host capability; absent/offline means pending.
  verifyProfile?(
    selection: NonNullable<Agent["profile_selection"]>,
  ): Promise<boolean>;
};

/** Destination inspection fails closed. No guessed identities or absent resources. */
export async function inspectSettingsDestination(
  port: SettingsReadPort,
  projectId: string,
  sections: SettingsSection[],
  mappings: SettingsMappings,
): Promise<SettingsSnapshot> {
  const identity = await port.identity();
  const rights = settingsRights(identity, projectId);
  if (!rights.principal)
    throw Object.assign(new Error("Destination identity is unavailable."), {
      code: "permission-denied",
    });
  const needed = new Set(sections);
  if (
    Object.entries(mappings.identities).some(
      ([key, v]) => key.startsWith("agent:") && !("drop" in v),
    )
  )
    needed.add("agents");
  for (const section of sections)
    if (!rights[section])
      throw Object.assign(
        new Error(`Cannot inspect and manage destination ${section}.`),
        { code: "permission-denied" },
      );
  const targets = Object.entries(mappings.identities)
    .filter(([key, v]) => key.startsWith("principal:") && !("drop" in v))
    .map(([, v]) => ("target" in v ? v.target : ""));
  const principals = targets.some((id) => id !== rights.principal)
    ? await port.principals()
    : [rights.principal];
  const agents = needed.has("agents") ? await port.agents(true) : [];
  const rooms = needed.has("rooms") ? await port.rooms(true) : [];
  const roomDetails: SettingsSnapshot["rooms"] = {};
  for (const room of rooms) {
    const detail = await port.room(room.id);
    if (!detail.members || detail.room.revision !== room.revision)
      throw Object.assign(
        new Error("Room changed during inspection; review again."),
        { code: "revision-conflict" },
      );
    roomDetails[room.id] = { room: detail.room, members: detail.members };
  }
  const verifiedProfiles: Agent["profile_selection"][] = [];
  for (const choice of Object.values(mappings.profiles))
    if ("selection" in choice) {
      try {
        if (await port.verifyProfile?.(choice.selection))
          verifiedProfiles.push(choice.selection);
      } catch {
        /* Offline/unknown capability evidence stays pending. Selection is still allowed. */
      }
    }
  return {
    projectId,
    rights,
    principals,
    agents: Object.fromEntries(agents.map((a) => [a.id, a])),
    rooms: roomDetails,
    signal_groups: Object.fromEntries(
      (needed.has("signal_groups") ? await port.groups() : []).map((g) => [
        g.id,
        g,
      ]),
    ),
    definitions: needed.has("definitions") ? await port.definitions() : null,
    readable: [...needed],
    verifiedProfiles,
  };
}

/** Failed reads abort; denied or deliberately unselected sections stay visible in coverage. */
export async function exportSettings(
  port: SettingsReadPort,
  projectId: string,
  options: {
    sections?: SettingsSection[];
    archivedIds?: string[];
    exportedAt?: string;
  } = {},
): Promise<SettingsDocument> {
  const identity = await port.identity();
  const rights = settingsRights(identity, projectId);
  if (!rights.principal)
    throw Object.assign(new Error("Source identity is unavailable."), {
      code: "permission-denied",
    });
  const sections = options.sections ?? ["agents", "rooms", "signal_groups"];
  const doc: SettingsDocument = {
    tila_export: {
      format: "tila-project-settings",
      format_version: 1,
      project_id: projectId,
      exported_at: options.exportedAt ?? new Date().toISOString(),
    },
    coverage: {
      definitions: {
        status: "omitted",
        scope: "visible",
        unavailable_fields: [],
      },
      agents: { status: "omitted", scope: "visible", unavailable_fields: [] },
      rooms: { status: "omitted", scope: "visible", unavailable_fields: [] },
      signal_groups: {
        status: "omitted",
        scope: "visible",
        unavailable_fields: [],
      },
    },
    settings: {},
  };
  const selected = (section: SettingsSection) => sections.includes(section);
  const archived = new Set(options.archivedIds ?? []);
  async function read<T>(
    section: SettingsSection,
    fetch: () => Promise<T>,
  ): Promise<T | undefined> {
    if (!selected(section)) return;
    try {
      const result = await fetch();
      doc.coverage[section].status = "read";
      return result;
    } catch (e) {
      const status =
        (e as { status?: number; statusCode?: number }).status ??
        (e as { statusCode?: number }).statusCode;
      if (
        status === 403 ||
        (e as { code?: string }).code === "permission-denied"
      ) {
        doc.coverage[section].status = "unavailable";
        return;
      }
      throw Object.assign(
        new Error(`Settings ${section} read failed; no export produced.`),
        { code: "export-incomplete" },
      );
    }
  }
  const definitions = await read("definitions", () => port.definitions());
  if (definitions) {
    doc.definitions = definitions.doc ?? {};
    doc.tila_export.definition_revision = definitions.revision;
  }
  const agents = await read("agents", () => port.agents(archived.size > 0));
  if (agents) {
    doc.settings.agents = {};
    for (const a of agents.filter(
      (a) => !a.archived || archived.has(`agent:${a.id}`),
    )) {
      const details = rights.agentDetails; // Conservatively omit current-consumer-only evidence.
      doc.settings.agents[a.id] = {
        name: a.name,
        source_revision: a.revision,
        archived: a.archived,
        ...(details
          ? {
              bind_policy: a.bind_policy,
              profile: a.profile_selection
                ? {
                    state: "selected" as const,
                    selection: {
                      profile_id: a.profile_selection.profile_id,
                      ...(a.profile_selection.host_ref
                        ? { host_ref: a.profile_selection.host_ref }
                        : {}),
                      ...(a.profile_selection.account_ref
                        ? { account_ref: a.profile_selection.account_ref }
                        : {}),
                    },
                  }
                : { state: "none" as const },
            }
          : {}),
      };
      if (!details)
        doc.coverage.agents.unavailable_fields.push(
          `${a.id}.bind_policy`,
          `${a.id}.profile`,
        );
    }
    if (rights.agents) doc.coverage.agents.scope = "project";
  }
  const rooms = await read("rooms", async () => {
    const list = await port.rooms(archived.size > 0);
    const out: NonNullable<SettingsDocument["settings"]["rooms"]> = {};
    for (const r of list.filter(
      (r) => !r.archived || archived.has(`room:${r.id}`),
    )) {
      const detail = await port.room(r.id);
      if (!detail.members || detail.room.revision !== r.revision)
        throw new Error("Room inspection changed or members are unreadable");
      out[r.id] = {
        name: r.name,
        history_policy: r.history_policy,
        delivery_ttl_seconds: r.delivery_ttl_seconds,
        budgets: r.budgets,
        archived: r.archived,
        source_revision: r.revision,
        members: detail.members.map((m) => ({
          member: m.member,
          wake: m.wake,
        })),
      };
    }
    return out;
  });
  if (rooms) {
    doc.settings.rooms = rooms;
    if (rights.rooms) doc.coverage.rooms.scope = "project";
  }
  const groups = await read("signal_groups", () => port.groups());
  if (groups) {
    doc.settings.signal_groups = Object.fromEntries(
      groups.map((g) => [
        g.id,
        {
          name: g.name,
          principal_ids: g.principal_ids,
          source_revision: g.revision,
        },
      ]),
    );
    doc.coverage.signal_groups.scope = "project";
  }
  const parsed = readSettingsTree(doc);
  if (!parsed.ok)
    throw Object.assign(new Error("Export contains invalid configuration."), {
      code: parsed.errors[0].code,
    });
  return parsed.value;
}

export function settingsReferences(doc: SettingsDocument): string[] {
  const refs = new Set<string>();
  for (const a of Object.values(doc.settings.agents ?? {}))
    for (const grant of a.bind_policy ?? []) {
      refs.add(`principal:${grant.principal_id}`);
      refs.add(`agent:${grant.agent_id}`);
    }
  for (const r of Object.values(doc.settings.rooms ?? {}))
    for (const m of r.members ?? []) refs.add(m.member);
  for (const g of Object.values(doc.settings.signal_groups ?? {}))
    for (const id of g.principal_ids) refs.add(`principal:${id}`);
  return [...refs].sort();
}
export function settingsSections(doc: SettingsDocument): SettingsSection[] {
  return ["definitions", "agents", "rooms", "signal_groups"].filter((s) =>
    s === "definitions"
      ? doc.definitions !== undefined
      : doc.settings[s as "agents"] !== undefined,
  ) as SettingsSection[];
}

/** Pure mapping and replacement planner. Any unresolved reference blocks all actions. */
export function planSettingsImport(
  input: SettingsDocument,
  decisions: SettingsMappings,
  destination: SettingsSnapshot,
  operationId: string,
  definitionStrategy?: "relax" | "force",
): SettingsResult<SettingsPlan> {
  const parsed = readSettingsTree(input);
  if (!parsed.ok) return parsed;
  const maps = SettingsMappingsSchema.safeParse(decisions);
  if (!maps.success)
    return {
      ok: false,
      errors: [error("invalid-mapping", "Invalid mapping decisions.")],
    };
  const doc = parsed.value;
  const mappings = maps.data;
  const references = settingsReferences(doc);
  const errors: SettingsError[] = [];
  const removals: string[] = [];
  const warnings = [
    "Omitted resources and hidden fields are retained. Source revisions are provenance only.",
  ];
  for (const section of settingsSections(doc))
    if (!destination.readable.includes(section) || !destination.rights[section])
      errors.push(
        error(
          "permission-denied",
          `Cannot inspect and manage destination ${section}.`,
        ),
      );
  const plannedAgents = new Set(
    Object.values(mappings.resources.agents)
      .filter((v) => !("drop" in v))
      .map((v) => ("id" in v ? v.id : "")),
  );
  for (const ref of references) {
    const choice = mappings.identities[ref];
    if (!choice) {
      errors.push(
        error(
          "unmapped-reference",
          "Explicitly map or drop this identity.",
          ref,
        ),
      );
      continue;
    }
    if ("drop" in choice) continue;
    const valid = ref.startsWith("principal:")
      ? destination.principals.includes(choice.target)
      : AgentRegistrationSchema.shape.id.safeParse(choice.target).success &&
        (plannedAgents.has(choice.target) ||
          (!!destination.agents[choice.target] &&
            !destination.agents[choice.target].archived));
    if (!valid)
      errors.push(
        error(
          "unknown-target",
          "The destination identity cannot be validated.",
          ref,
        ),
      );
  }
  const mapped = (ref: string) => {
    const v = mappings.identities[ref];
    return v && "target" in v ? `${ref.split(":")[0]}:${v.target}` : null;
  };
  const actions: SettingsAction[] = [];
  function add(action: Omit<SettingsAction, "id">): string {
    const id = `${operationId}:${actions.length}`;
    actions.push({ ...action, id } as SettingsAction);
    return id;
  }
  const used = new Set<string>();
  function select(
    section: "agents" | "rooms" | "signal_groups",
    source: string,
    archived = false,
  ) {
    const v = mappings.resources[section][source];
    if (!v) {
      errors.push(
        error(
          "unmapped-resource",
          "Choose a destination resource or drop it.",
          `${section}.${source}`,
        ),
      );
      return null;
    }
    if ("drop" in v) return null;
    if (archived) {
      errors.push(
        error(
          "archived-source",
          "Archived resources require a separate lifecycle decision; transfer never revives them.",
          `${section}.${source}`,
        ),
      );
      return null;
    }
    const key = `${section}:${v.id}`;
    if (used.has(key))
      errors.push(
        error(
          "duplicate-target",
          "Two resources cannot replace one destination.",
          key,
        ),
      );
    used.add(key);
    const current =
      section === "rooms"
        ? destination.rooms[v.id]?.room
        : destination[section][v.id];
    if ((v.mode === "create" && current) || (v.mode === "update" && !current))
      errors.push(
        error(
          "create-collision",
          "Destination selection does not match inspected state.",
          key,
        ),
      );
    if (
      current &&
      (("archived" in current && current.archived) || current.revision <= 0)
    )
      errors.push(
        error(
          "revision-unavailable",
          "Archived or revisionless resources cannot be updated.",
          key,
        ),
      );
    return v;
  }
  if (doc.definitions !== undefined && destination.definitions) {
    if (Object.keys(doc.definitions).length) {
      const plan = planDefinitionImport(
        destination.definitions.doc,
        doc.definitions,
        "merge",
      );
      if (!plan.ok) errors.push(...plan.errors);
      else if (!plan.noChange)
        add({
          kind: "definitions",
          resource_id: destination.projectId,
          expected_revision: destination.definitions.revision,
          payload: {
            definition: plan.source,
            ...(definitionStrategy ? { strategy: definitionStrategy } : {}),
          },
        });
    }
  }
  for (const [source, a] of sorted(doc.settings.agents ?? {})) {
    const target = select("agents", source, a.archived);
    if (!target) continue;
    const current = destination.agents[target.id];
    const grants = a.bind_policy?.flatMap((g) => {
      const principal = mapped(`principal:${g.principal_id}`);
      const agent = mapped(`agent:${g.agent_id}`);
      if (!principal || !agent) return [];
      if (agent !== `agent:${target.id}`)
        errors.push(
          error(
            "invalid-policy",
            "A binding grant must map to its destination agent.",
            `agents.${source}`,
          ),
        );
      return [{ principal_id: principal.slice(10), agent_id: agent.slice(6) }];
    });
    const payload: {
      name: string;
      bind_policy?: Agent["bind_policy"];
      profile_selection?: Agent["profile_selection"];
    } = {
      name: a.name,
      ...(grants !== undefined ? { bind_policy: grants } : {}),
    };
    if (grants && current)
      for (const g of current.bind_policy)
        if (!grants.some((x) => same(x, g)))
          removals.push(`agent:${target.id} grant principal:${g.principal_id}`);
    if (a.profile?.state === "none") payload.profile_selection = null;
    if (a.profile?.state === "selected") {
      const choice = mappings.profiles[source];
      if (!choice)
        errors.push(
          error(
            "unmapped-profile",
            "Choose a destination profile or drop the selection.",
            `agents.${source}.profile`,
          ),
        );
      else if ("drop" in choice) payload.profile_selection = null;
      else {
        payload.profile_selection = choice.selection;
        warnings.push(
          `agent:${target.id} destination profile ${choice.selection.profile_id}: ${destination.verifiedProfiles.some((p) => same(p, choice.selection)) ? "verified by destination capability" : "pending/unverified; live verification unavailable"}. Selection only; no runtime is started or bound.`,
        );
      }
    }
    if (target.mode === "create") {
      if (grants === undefined)
        errors.push(
          error(
            "hidden-create-policy",
            "A hidden binding policy cannot be guessed for a new agent.",
            `agents.${source}`,
          ),
        );
      const create = AgentRegistrationSchema.safeParse({
        id: target.id,
        name: a.name,
        bind_policy: grants ?? [],
      });
      if (!create.success) {
        errors.push(
          error(
            "invalid-policy",
            "Invalid destination binding policy.",
            `agents.${source}`,
          ),
        );
        continue;
      }
      const prior = add({
        kind: "agent.create",
        resource_id: target.id,
        payload: create.data,
      });
      if (payload.profile_selection)
        add({
          kind: "agent.update",
          resource_id: target.id,
          revision_from: prior,
          payload: { profile_selection: payload.profile_selection },
        });
    } else if (
      current &&
      Object.entries(payload).some(
        ([k, v]) => !same(current[k as keyof Agent], v),
      )
    )
      add({
        kind: "agent.update",
        resource_id: target.id,
        expected_revision: current.revision,
        payload,
      });
  }
  for (const [source, r] of sorted(doc.settings.rooms ?? {})) {
    const target = select("rooms", source, r.archived);
    if (!target) continue;
    const current = destination.rooms[target.id];
    const config = {
      name: r.name,
      history_policy: r.history_policy,
      delivery_ttl_seconds: r.delivery_ttl_seconds,
      budgets: r.budgets,
    };
    let prior: string | undefined;
    if (target.mode === "create") {
      prior = add({
        kind: "room.create",
        resource_id: target.id,
        payload: CreateRoomSchema.parse({ id: target.id, ...config }),
      });
      warnings.push(
        `room:${target.id} creation adds ${destination.rights.creatorMember} with wake=false; membership reconciliation follows and removes the creator last if reviewed.`,
      );
    } else if (
      current &&
      Object.entries(config).some(
        ([k, v]) => !same(current.room[k as keyof Room], v),
      )
    )
      prior = add({
        kind: "room.update",
        resource_id: target.id,
        expected_revision: current.room.revision,
        payload: config,
      });
    if (r.members === undefined) continue;
    const members = r.members.flatMap((m) => {
      const member = mapped(m.member);
      return member ? [{ member, wake: m.wake }] : [];
    });
    const unique = new Map<string, boolean>();
    for (const m of members) {
      if (unique.has(m.member) && unique.get(m.member) !== m.wake)
        errors.push(
          error(
            "member-collision",
            "Mapped members have conflicting wake settings.",
            `rooms.${source}`,
          ),
        );
      unique.set(m.member, m.wake);
    }
    const before = current?.members ?? [
      { member: destination.rights.creatorMember, wake: false },
    ];
    const revision = () =>
      prior
        ? { revision_from: prior }
        : { expected_revision: current?.room.revision };
    for (const [member, wake] of [...unique].sort(([a], [b]) =>
      compareSettingsKeys(a, b),
    ))
      if (!before.some((m) => m.member === member && m.wake === wake))
        prior = add({
          kind: "room.member",
          resource_id: target.id,
          ...revision(),
          payload: { member, wake },
        });
    const remove = before
      .filter((m) => !unique.has(m.member))
      .sort(
        (a, b) =>
          Number(a.member === destination.rights.creatorMember) -
            Number(b.member === destination.rights.creatorMember) ||
          compareSettingsKeys(a.member, b.member),
      );
    for (const m of remove) {
      removals.push(`room:${target.id} member ${m.member}`);
      prior = add({
        kind: "room.member",
        resource_id: target.id,
        ...revision(),
        payload: { member: m.member, wake: null },
      });
    }
  }
  for (const [source, g] of sorted(doc.settings.signal_groups ?? {})) {
    const target = select("signal_groups", source);
    if (!target) continue;
    const current = destination.signal_groups[target.id];
    const principal_ids = [
      ...new Set(
        g.principal_ids.flatMap((id) => {
          const v = mapped(`principal:${id}`);
          return v ? [v.slice(10)] : [];
        }),
      ),
    ].sort();
    if (current)
      for (const id of current.principal_ids)
        if (!principal_ids.includes(id))
          removals.push(`group:${target.id} recipient principal:${id}`);
    const payload = { name: g.name, principal_ids };
    if (
      !current ||
      current.name !== g.name ||
      !same([...current.principal_ids].sort(), principal_ids)
    )
      add({
        kind: "group.set",
        resource_id: target.id,
        expected_revision: current?.revision ?? 0,
        payload,
      });
  }
  if (errors.length) return { ok: false, errors };
  const plan = SettingsPlanSchema.safeParse({
    format: "tila-settings-plan",
    version: 1,
    operation_id: operationId,
    project_id: destination.projectId,
    creator_member: destination.rights.creatorMember,
    mappings,
    actions,
    references,
    removals,
    warnings,
    coverage: doc.coverage,
  });
  return plan.success
    ? { ok: true, value: plan.data }
    : {
        ok: false,
        errors: [error("invalid-plan", "The resulting plan is invalid.")],
      };
}

export function appliedSettingsDefinition(response: {
  revision?: number;
  version?: number | null;
  schema?: unknown;
}): CurrentDefinition {
  const revision = response.revision ?? response.version ?? 0;
  const value = response.schema;
  if (value == null)
    return currentDefinition({ revision, version: revision, definition: null });
  if (typeof value === "string")
    return currentDefinition({
      revision,
      version: revision,
      definition: value,
    });
  if (
    typeof value === "object" &&
    "definition" in value &&
    typeof value.definition === "string"
  )
    return currentDefinition({
      revision,
      version: revision,
      definition: value.definition,
    });
  throw Object.assign(new Error("The applied definition is unreadable."), {
    code: "schema-corrupt",
  });
}
