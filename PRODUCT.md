# Product

## Register

product

## Users

Solo engineers and small teams (3-6 people) running AI coding agents across multiple machines on pre-MVP projects. The pain: machines don't see each other's state; in-repo artifacts pollute the codebase; switching machines means losing in-flight context.

Context of use: engineers glancing at the read-only dashboard between coding sessions, or interacting via CLI during active development. The dashboard is an observability surface, not a workspace.

## Product Purpose

**tila** (Finnish: state, space, condition, mode) is a state-and-coordination engine for multi-machine agentic work. Cloudflare-native (Worker + DO SQLite + D1 + R2).

Core flow: provision with `tila init --cloudflare`, coordinate with `tila task claim` (first-writer-wins via fencing tokens), store content-addressed artifacts in R2, review state through a read-only dashboard showing presence, claims, and journal.

Success: engineers and their agents never silently conflict, never lose in-flight context when switching machines, and never pollute the repo with coordination artifacts.

## Brand Personality

Precise, quiet, reliable. Infrastructure-grade tooling that stays out of the way. The CLI and dashboard should feel like something built by someone who uses it daily. No marketing language, no aspirational feature descriptions, no personality performance.

## Anti-references

- **SaaS observability dashboards (Datadog, New Relic)**: no marketing chrome, no upsell surfaces, no feature-discovery UX, no gradient hero metrics. tila is self-hosted infrastructure, not a vendor product.
- **Heavy PM tools (Jira, Monday)**: no deep navigation trees, no modal-driven workflows, no configuration sprawl, no settings pages disguised as features.
- **Terminal-aesthetic cosplay**: no fake terminal fonts in the web UI, no green-on-black for style points, no retro aesthetics for their own sake. tila is a real tool, not a theme.

## Design Principles

1. **Information density over decoration.** The dashboard is an observability surface. Every pixel should communicate state. Whitespace serves scanability, not aesthetics.
2. **Show state, not chrome.** Entity lists, claim states, journal tails, presence indicators. The UI is a window into coordination state, not a product experience.
3. **Quiet confidence.** No loading spinners where static data suffices. No confirmation modals for read-only views. No tooltips explaining the obvious. Trust the user's expertise.
4. **CLI-first, dashboard-second.** The CLI is the primary interface. The dashboard exists to answer "what's happening across all my projects right now?" at a glance. It doesn't duplicate CLI workflows.

## Accessibility & Inclusion

WCAG AA baseline: contrast ratios, keyboard navigation, screen reader semantics. The dashboard's data-dense layout must remain navigable without a mouse.
