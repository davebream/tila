# Project dashboard

The Worker serves this React SPA. Project cookie sessions authenticate requests;
current server membership and credential policy authorize every operation.

## Conversations

- **Rooms** opens recent room history. Thread panels have shareable `?thread=UUID`
  URLs. Backward pages and forward tail polling use separate signed cursors.
- **Agents** shows current binding epochs, wake mechanisms and lease expiry.
  Delivery inspection takes an agent and delivery UUID from CLI inbox/dispatch
  metadata. Its project URL can be reopened; access is checked on every poll.
- **Replies** use plain text and author-scoped operation IDs. Tab sessionStorage
  preserves the exact pending request through network retries and fresh sign-in.
  New edits survive late responses. No message body is interpreted as markup or
  approval; the dashboard never fetches or acknowledges an agent's inbox.

Streams render at most 200 messages and pause visible updates when reading older
content. Announcements are opt-in. Drawers support Escape and restore focus to the
opening control, or the room heading for a direct link.

Deploy the compatible conversation server before this bundle. Browser previews and
component fixtures are UI validation, not evidence of native account isolation or
Mac/Linux acceptance. See [the acceptance record](../../docs/evidence/issue-283-acceptance-v3.json).

## Development

From the repository root, use `pnpm dev` for the Worker and UI together. Run
`pnpm --filter @tila/ui test` and `pnpm --filter @tila/ui typecheck` for targeted
checks. Tests mock HTTP through MSW; production builds remain part of `pnpm test`.
