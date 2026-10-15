import {
  type Capability,
  type CredentialPolicy,
  PROJECT_ROLE_RANK,
  type ProjectRole,
  RESTRICTED_CREDENTIAL_SURFACES,
  type RecordAccessSide,
  type SessionCapabilities,
  type WhoamiResponse,
  hasNamespaceRestrictions,
  permitsAnyRecordSide,
} from "@tila/schemas";

// One navigation model for the header, the section sub-navigation and the
// command palette (#306). Sections group the existing project URLs; no page
// moved, so every deep link keeps resolving to the same view.

export type SectionId =
  | "overview"
  | "work"
  | "conversations"
  | "runtime"
  | "settings";

export interface NavItem extends AccessTarget {
  id: string;
  label: string;
  /** Path below `/p/:projectId/`, without a leading slash. */
  segment: string;
  /** Capabilities the page's primary read needs. */
  requires: readonly Capability[];
  /** First API path segment the page reads, for restricted credentials. */
  surface?: string;
  /** Extra palette search terms. */
  keywords?: readonly string[];
  /** Active only on the exact path, not on nested pages below it. */
  end?: boolean;
}

/** The boolean flags of `SessionCapabilities`, one per owner-level editor. */
export type SessionFlag = {
  [K in keyof SessionCapabilities]-?: SessionCapabilities[K] extends boolean
    ? K
    : never;
}[keyof SessionCapabilities];

/** Anything gated on capabilities and the restricted-credential surfaces. */
export interface AccessTarget {
  requires: readonly Capability[];
  /** A page spanning independently readable sections needs at least one. */
  requiresAny?: readonly Capability[];
  surface?: string;
  /**
   * The side of the record namespace the page works on. A credential whose
   * record rules admit nothing on that side has nothing to open there, so the
   * item is hidden even when it holds the capability.
   */
  records?: RecordAccessSide;
  /**
   * Session flags from `/auth/session/status`; the item needs at least one.
   * Owner-level editors whose reads are owner-only use these.
   */
  flags?: readonly SessionFlag[];
  /** Lowest project role that can use the page at all. */
  minRole?: ProjectRole;
}

/** What Settings › Definitions needs; shared with every link that points there. */
export const DEFINITIONS_ACCESS: AccessTarget = {
  requires: ["schema:read"],
  surface: "schema",
};

export interface NavSection {
  id: SectionId;
  label: string;
  /** The first visible item is the section's landing page. */
  items: readonly NavItem[];
}

export const NAV_SECTIONS: readonly NavSection[] = [
  {
    id: "overview",
    label: "Overview",
    items: [
      {
        id: "overview",
        label: "Overview",
        segment: "overview",
        requires: [],
        keywords: ["attention", "home", "setup"],
      },
    ],
  },
  {
    id: "work",
    label: "Work",
    items: [
      {
        id: "tasks",
        label: "Tasks",
        segment: "tasks",
        requires: ["tasks:read"],
        surface: "tasks",
        keywords: ["work items"],
      },
      {
        id: "queue",
        label: "Queue",
        segment: "queue",
        requires: ["tasks:read"],
        surface: "queue",
        keywords: ["execution", "attempts"],
      },
      {
        id: "decisions",
        label: "Decisions",
        segment: "decisions",
        requires: ["tasks:read"],
        surface: "questions",
        keywords: ["questions", "inbox", "answer", "escalation"],
      },
      {
        id: "records",
        label: "Records",
        segment: "records",
        requires: ["records:read"],
        surface: "records",
        records: "read",
      },
      {
        id: "artifacts",
        label: "Artifacts",
        segment: "artifacts",
        requires: ["artifacts:read"],
        surface: "artifacts",
        keywords: ["files", "outputs"],
      },
      {
        id: "journal",
        label: "Journal",
        segment: "journal",
        requires: ["journal:read"],
        surface: "journal",
        keywords: ["history", "audit", "events"],
      },
    ],
  },
  {
    id: "conversations",
    label: "Conversations",
    items: [
      {
        id: "rooms",
        label: "Rooms",
        segment: "rooms",
        requires: ["conversations:read"],
        surface: "rooms",
        keywords: ["messages", "threads"],
      },
      {
        id: "deliveries",
        label: "Deliveries",
        segment: "deliveries",
        requires: ["conversations:manage"],
        surface: "deliveries",
        keywords: ["wake", "acknowledgement"],
      },
      {
        id: "signals",
        label: "Signals",
        segment: "signals",
        requires: ["signals:read"],
        surface: "signals",
      },
    ],
  },
  {
    id: "runtime",
    label: "Runtime",
    items: [
      {
        id: "runtime",
        label: "Runtime",
        segment: "runtime",
        requires: ["agents:read"],
        surface: "runtime-view",
        keywords: ["hosts", "sessions", "runs"],
      },
      {
        id: "agents",
        label: "Agents",
        segment: "agents",
        requires: ["agents:read"],
        surface: "agents",
        keywords: ["mailboxes"],
      },
      {
        id: "presence",
        label: "Presence",
        segment: "presence",
        requires: ["presence:read"],
        surface: "presence",
        keywords: ["participants", "online"],
      },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    items: [
      {
        id: "settings",
        label: "Access",
        segment: "settings",
        requires: [],
        keywords: ["settings", "members", "credentials", "tokens"],
        end: true,
      },
      {
        id: "general",
        label: "General",
        segment: "settings/general",
        requires: ["summary:read"],
        surface: "project-settings",
        keywords: ["project name", "display name", "rename"],
      },
      {
        id: "repositories",
        label: "Repositories",
        segment: "settings/repositories",
        requires: ["repository-policy:read"],
        surface: "repos",
        flags: ["repository_policy_manage"],
        keywords: ["github", "oidc", "actions", "access policy"],
      },
      {
        id: "service-identities",
        label: "Service identities",
        segment: "settings/service-identities",
        requires: ["service-accounts:read"],
        surface: "service-accounts",
        flags: ["service_accounts_manage", "workload_bindings_manage"],
        keywords: ["service accounts", "workload bindings", "ci"],
      },
      {
        id: "credentials",
        label: "Credentials",
        segment: "settings/credentials",
        requires: ["tokens:read"],
        surface: "tokens",
        flags: ["credentials_read", "credentials_manage", "credentials_issue"],
        keywords: ["tokens", "api keys", "issue", "rotate"],
      },
      {
        id: "runtime-access",
        label: "Runtime access",
        segment: "settings/runtime-access",
        requires: [],
        surface: "runtime",
        // Viewers cannot sponsor installations; owners also see invitations.
        minRole: "participant",
        keywords: ["installations", "machines", "enrollments", "invitations"],
      },
      {
        id: "definitions",
        label: "Definitions",
        segment: "settings/definitions",
        ...DEFINITIONS_ACCESS,
        keywords: ["schema", "types", "fields", "lifecycle"],
      },
      {
        id: "agent-settings",
        label: "Agents",
        segment: "settings/agents",
        requires: ["agents:read"],
        surface: "agents",
        keywords: ["register agent", "binding grants", "profile", "archive"],
      },
      {
        id: "settings-transfer",
        label: "Settings transfer",
        segment: "settings/transfer",
        requires: [],
        requiresAny: ["agents:read", "conversations:read", "signals:read"],
        // All transfer sections use non-namespace settings endpoints. Keep
        // restricted credentials out while the page reports section coverage.
        surface: "agents",
        keywords: ["export", "import", "template", "remap", "resume"],
      },
      {
        id: "room-settings",
        label: "Rooms",
        segment: "settings/rooms",
        requires: ["conversations:read"],
        surface: "rooms",
        keywords: ["create room", "room members", "history policy", "budgets"],
      },
      {
        id: "signal-group-settings",
        label: "Signal groups",
        segment: "settings/signal-groups",
        requires: ["signals:read"],
        surface: "signals",
        keywords: ["groups", "recipients"],
      },
    ],
  },
];

/** Where a project opens when no specific page was requested. */
export const DEFAULT_SEGMENT = "overview";

export function defaultProjectPath(projectId: string): string {
  return `/p/${projectId}/${DEFAULT_SEGMENT}`;
}

/** First path segments that belong to a project view, including aliases. */
export const PROJECT_SEGMENTS: ReadonlySet<string> = new Set([
  ...NAV_SECTIONS.flatMap((section) =>
    section.items.map((item) => item.segment.split("/")[0]),
  ),
  "entities",
]);

export interface NavMatch {
  section: NavSection;
  item: NavItem;
}

/**
 * The section and item that own a pathname. Accepts `/p/:projectId/...` or a
 * project-relative path; the longest matching item segment wins, so a nested
 * item (for example a settings sub-page) is preferred over its parent.
 */
export function matchNav(pathname: string): NavMatch | null {
  const rest = pathname
    .replace(/^\/p\/[^/]+(?=\/|$)/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  const path = rest.startsWith("entities")
    ? `tasks${rest.slice("entities".length)}`
    : rest;
  let best: NavMatch | null = null;
  for (const section of NAV_SECTIONS)
    for (const item of section.items) {
      const hit = path === item.segment || path.startsWith(`${item.segment}/`);
      if (hit && (!best || item.segment.length > best.item.segment.length))
        best = { section, item };
    }
  return best;
}

const RESTRICTED_SURFACES: ReadonlySet<string> = new Set(
  RESTRICTED_CREDENTIAL_SURFACES,
);

export function isRestricted(identity: WhoamiResponse | undefined): boolean {
  const policy = identity?.policy as CredentialPolicy | undefined;
  return policy ? hasNamespaceRestrictions(policy) : false;
}

/**
 * Whether the current identity can use a navigation item. Hiding is only a
 * convenience: a deep link still opens the page, which renders its own
 * forbidden state. Without a readable identity for this project every item
 * stays visible rather than guessing.
 */
export function navVisibility(
  identity: WhoamiResponse | undefined,
  projectId: string | null,
  /** Session flags; unknown (null or omitted) keeps flagged items visible. */
  session?: SessionCapabilities | null,
): (item: AccessTarget) => boolean {
  const flagged = (item: AccessTarget) =>
    !item.flags?.length ||
    !session ||
    item.flags.some((flag) => session[flag] === true);
  const own = projectId && identity?.project_id === projectId;
  const role = own ? identity?.role : undefined;
  const ranked = (item: AccessTarget) =>
    !item.minRole ||
    !role ||
    PROJECT_ROLE_RANK[role] >= PROJECT_ROLE_RANK[item.minRole];
  const policy = identity?.policy as CredentialPolicy | undefined;
  if (!policy || !own) return (item) => flagged(item) && ranked(item);
  const capabilities = new Set<string>(policy.capabilities);
  const restricted = hasNamespaceRestrictions(policy);
  return (item) =>
    flagged(item) &&
    ranked(item) &&
    item.requires.every((cap) => capabilities.has(cap)) &&
    (!item.requiresAny?.length ||
      item.requiresAny.some((cap) => capabilities.has(cap))) &&
    (!restricted ||
      item.surface === undefined ||
      RESTRICTED_SURFACES.has(item.surface)) &&
    (item.records === undefined ||
      permitsAnyRecordSide(policy.restrictions, item.records));
}

/** Sections with at least one visible item, holding only those items. */
export function visibleSections(
  isVisible: (item: NavItem) => boolean,
): NavSection[] {
  return NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter(isVisible),
  })).filter((section) => section.items.length > 0);
}
