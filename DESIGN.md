---
name: tila
description: State-and-coordination engine for multi-machine agentic work
colors:
  deep-void: "#0f1117"
  slate-surface: "#1a1d27"
  wire-border: "#2a2d3a"
  light-gray: "#e1e4ed"
  muted-gray: "#8b8fa3"
  signal-blue: "#6c8aff"
  signal-blue-hover: "#8ba3ff"
  status-green: "#4ade80"
  status-amber: "#fbbf24"
  status-red: "#f87171"
typography:
  logo:
    fontFamily: "'Space Grotesk', -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "26px"
    fontWeight: 700
    letterSpacing: "-0.03em"
  heading:
    fontFamily: "'Space Grotesk', -apple-system, BlinkMacSystemFont, sans-serif"
    fontSize: "20px"
    fontWeight: 500
    letterSpacing: "-0.02em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "10px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.08em"
  data:
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "6px"
  full: "12px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  section: "48px"
components:
  button-primary:
    backgroundColor: "{colors.signal-blue}"
    textColor: "#f0f1f4"
    rounded: "{rounded.sm}"
    padding: "10px 24px"
  button-primary-hover:
    backgroundColor: "{colors.signal-blue-hover}"
  input-default:
    backgroundColor: "{colors.slate-surface}"
    textColor: "{colors.light-gray}"
    rounded: "{rounded.sm}"
    padding: "10px 14px"
  badge-entity:
    backgroundColor: "rgba(108, 138, 255, 0.15)"
    textColor: "{colors.signal-blue}"
    rounded: "{rounded.full}"
    padding: "4px 10px"
  badge-claim:
    backgroundColor: "rgba(251, 191, 36, 0.15)"
    textColor: "{colors.status-amber}"
    rounded: "{rounded.full}"
    padding: "4px 10px"
  nav-link:
    textColor: "{colors.muted-gray}"
    rounded: "{rounded.sm}"
    padding: "4px 8px"
  nav-link-active:
    textColor: "{colors.signal-blue}"
    backgroundColor: "rgba(108, 138, 255, 0.1)"
---

# Design System: tila

## 1. Overview

**Creative North Star: "The Control Room"**

tila's interface is a monitoring station. Everything is visible; nothing demands attention until it should. The dashboard exists to answer one question at a glance: what's happening across all my projects right now? It is a window into coordination state, not a product experience.

The visual system is dark, dense, and monospaced where data lives. Color is functional: blue for navigation and interaction, green/amber/red for status. Surfaces are flat by default, with tonal layering (void to surface to border) creating spatial hierarchy without shadows. The system sans-serif handles navigation and labels; monospace handles data. There is no display typeface because there are no heroes, no marketing, no decoration.

This is infrastructure UI. It should feel like something an engineer built for engineers, then polished until it was comfortable without ever becoming cute.

**Key Characteristics:**
- Data tables in monospace, not cards
- Color reserved for status signals and interactive affordances
- Flat tonal layering; shadows only for future overlays (popovers, dropdowns)
- Space Grotesk for logo/headings; system fonts for body/labels; system mono for data
- Single breakpoint at 768px, compact layout for mobile
- Ghost-style filter buttons; solid accent only for primary login action

## 2. Colors

The palette is a dark void with one blue signal and three status channels. Color is rationed; its scarcity is the point.

### Primary

- **Signal Blue** (`#6c8aff`): the sole interactive accent. Navigation links, active states, primary buttons, task badges. Used at 100% opacity for foreground (text, icons) and 10-15% opacity for tinted backgrounds (active nav, badge fills). Hover lightens to **Signal Blue Hover** (`#8ba3ff`).

### Neutral

- **Deep Void** (`#0f1117`): page background. The darkest surface in the system.
- **Slate Surface** (`#1a1d27`): elevated containers. Nav bar, code blocks, filter inputs, table header region. One step above void.
- **Wire Border** (`#2a2d3a`): all borders and dividers. Thin (1px), structural, never decorative.
- **Light Gray** (`#e1e4ed`): primary text. High contrast against void and surface.
- **Muted Gray** (`#8b8fa3`): secondary text, labels, table headers, empty states. Readable but recessive.

### Status (functional only)

- **Status Green** (`#4ade80`): active presence, success, artifact badges. Used at 15-20% opacity for badge backgrounds.
- **Status Amber** (`#fbbf24`): warnings, paused polling, claim badges, FTS5 search highlights.
- **Status Red** (`#f87171`): errors, schema badges. The error banner inverts to red background with dark text.

### Named Rules

**The Signal Scarcity Rule.** Signal Blue is the only chromatic accent outside status colors. If a new interactive element needs color, it uses Signal Blue. If a new status needs color, it must be green, amber, or red with established semantics. No new hues without a new semantic role.

**The 15% Opacity Rule.** Status and accent colors appear at full saturation only as foreground (text, icons). As backgrounds (badges, active states, hovers), they appear at 10-20% opacity over Slate Surface or Deep Void. This keeps the dark theme coherent and prevents color islands.

## 3. Typography

**Logo/Heading Font:** Space Grotesk (`"Space Grotesk", -apple-system, BlinkMacSystemFont, sans-serif`) — loaded from Google Fonts. Used only for the logo mark and view headings. Geometric, technical precision with warmth.
**Body Font:** System sans-serif (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`)
**Data Font:** System monospace (`"SF Mono", "Fira Code", "Cascadia Code", monospace`)

**Character:** Three stacks. Space Grotesk provides brand identity on the logo and view-level headings. The system sans handles navigation, labels, and prose. The mono handles everything that represents data: tables, journal events, entity keys, code blocks, filter inputs. The mono is the dominant typeface by surface area.

### Hierarchy

- **Logo** (Space Grotesk, 700, 26px, -0.03em tracking): the "tila" wordmark in the login and nav. Paired with a blue logo mark.
- **View Heading** (Space Grotesk, 500, 20px, -0.02em tracking): entity IDs, "Journal", "Artifacts", etc. The largest text in authenticated views.
- **Body** (sans, 400, 14px, 1.5): navigation, descriptions, form labels (at 13px muted).
- **Data** (mono, 400, 13px, 1.5): table cells, journal entries, badge text, filter inputs. The workhorse.
- **Label** (sans, 600, 10px, 1.3, uppercase, 0.08em tracking): table column headers, section headings, KV table keys. Small, authoritative, recessive.

### Named Rules

**The Mono Default Rule.** If the content represents server state (entity types, keys, timestamps, claim holders, artifact hashes), it renders in monospace. Sans-serif is for UI chrome: navigation, section headings, labels, empty-state messages. When in doubt, mono.

## 4. Elevation

Flat by default. Depth is conveyed through tonal layering: Deep Void (lowest) to Slate Surface (elevated) to Wire Border (edges). No shadows exist in the current system.

Ambient shadows are reserved for future interactive overlays: popovers, dropdown menus, combobox panels, or toast notifications. When introduced, they should be diffuse and cool-tinted (blue-black, not warm black), consistent with the void palette.

### Named Rules

**The Flat Rest Rule.** Surfaces are flat at rest. If a shadow appears, it means something is floating above the page plane (a dropdown, a popover). Shadows are a spatial signal, not a decorative choice.

## 5. Components

### Navigation

Top nav bar on Slate Surface with Wire Border bottom edge. Links in sans-serif at 14px, Muted Gray by default. Active and hover states tint to Signal Blue text with a 10% blue background wash. Horizontal layout with 16px gap; wraps on mobile.

### Tables

The primary data display. Monospace throughout at 13px. Column headers are Label style (11px, uppercase, 600 weight, Muted Gray). Row borders are 1px Wire Border. Hover adds an almost-imperceptible white tint (2% opacity) for scan tracking. No zebra striping.

### Badges

Pill-shaped (full radius at 12px) indicators for task types and status. 12px font, 600 weight, 4px 10px padding. Each variant pairs a status/accent color at 15% opacity background with the full-saturation color as text. Compact enough to sit inline in table cells.

### Buttons

Signal Blue background, near-white text, 6px radius, 10px 24px padding. Hover lightens to Signal Blue Hover. No border, no shadow, no transition beyond background color (0.15s). Functional; not a call to action.

### Inputs

Slate Surface background, Wire Border, 6px radius, 10px 14px padding. Filter inputs use sans at 13px; form inputs (setup, token entry) use mono at 14px. No focus ring defined yet; should adopt a 2px Signal Blue outline on `:focus-visible`.

### Journal Events

Monospace list items at 13px, 8px 12px padding, separated by Wire Border. Hover matches table row hover. Collapsible data payloads render in `<pre>` blocks with Slate Surface background.

### Empty States

Centered Muted Gray text at default size, 48px vertical padding. No icons, no illustrations, no call-to-action buttons. States the absence plainly.

## 6. Do's and Don'ts

### Do:

- **Do** use monospace for any content that represents server state: task keys, timestamps, claim holders, artifact hashes, journal payloads.
- **Do** use the 15% opacity pattern for colored backgrounds. Full-saturation backgrounds are reserved for the error banner and primary buttons only.
- **Do** keep interactive color to Signal Blue. Consistency across nav, links, buttons, and task badges makes the accent learnable.
- **Do** maintain the tonal stack (Void < Surface < Border) for spatial hierarchy. Adding a fourth tonal level requires a design decision, not a new hex.
- **Do** test contrast against WCAG AA on both Deep Void and Slate Surface backgrounds.

### Don't:

- **Don't** add gradient hero metrics, big-number stat cards, or marketing chrome. This is not a SaaS vendor dashboard (not Datadog, not New Relic).
- **Don't** introduce deep navigation trees, modal-driven workflows, or configuration sprawl. This is not a PM tool (not Jira, not Monday).
- **Don't** use terminal-aesthetic cosplay: fake terminal fonts for decoration, green-on-black for style, or retro themes. tila uses real monospace for real data, not as a costume.
- **Don't** add display typefaces or typographic flair beyond Space Grotesk for the logo/headings. System stacks handle body and data.
- **Don't** introduce new hues outside the five-color vocabulary (blue, green, amber, red, gray) without defining a new semantic role first.
- **Don't** use box-shadows on resting surfaces. Shadows are reserved for floating overlays.
- **Don't** use colored side-stripe borders (`border-left` > 1px) on any element. Badges handle type differentiation; borders are structural only.
- **Don't** use cards where a table row or list item would do. The table is the primary layout for data in this system.
