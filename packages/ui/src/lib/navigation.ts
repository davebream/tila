import {
  type Capability,
  type CredentialPolicy,
  RESTRICTED_CREDENTIAL_SURFACES,
  type WhoamiResponse,
  hasNamespaceRestrictions,
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

export interface NavItem {
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

/** Anything gated on capabilities and the restricted-credential surfaces. */
export interface AccessTarget {
  requires: readonly Capability[];
  surface?: string;
}

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
        id: "records",
        label: "Records",
        segment: "records",
        requires: ["records:read"],
        surface: "records",
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
        id: "definitions",
        label: "Definitions",
        segment: "settings/definitions",
        requires: ["schema:read"],
        surface: "schema",
        keywords: ["schema", "types", "fields", "lifecycle"],
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
): (item: AccessTarget) => boolean {
  const policy = identity?.policy as CredentialPolicy | undefined;
  if (!policy || !projectId || identity?.project_id !== projectId)
    return () => true;
  const capabilities = new Set<string>(policy.capabilities);
  const restricted = hasNamespaceRestrictions(policy);
  return (item) =>
    item.requires.every((cap) => capabilities.has(cap)) &&
    (!restricted ||
      item.surface === undefined ||
      RESTRICTED_SURFACES.has(item.surface));
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
