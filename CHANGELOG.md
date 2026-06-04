# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-06-04

First public release.

### Added

- Content-addressed artifact storage (R2, sha256-keyed, deduplicated) with FTS5 full-text search and server-side grep
- Typed, schema-validated records with revision history and fencing tokens
- Coordination primitives: claims, gates, signals, presence, and an append-only journal
- First-writer-wins concurrency with monotonic fencing tokens (stale writes rejected)
- Cloudflare deployment path (Worker + Durable Object SQLite + D1 + R2) and local mode (`tila init --local`, bun:sqlite)
- `tila` CLI distributed as self-contained native binaries for macOS, Linux (glibc + musl), and Windows
- TypeScript SDK (`tila-sdk`) and MCP server (`tila-mcp-server`) for Claude Code, Cursor, and VS Code
- Read-only dashboard SPA served by the Worker
- GitHub-scoped authentication (default) and D1 API tokens (admin)

[Unreleased]: https://github.com/davebream/tila/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/davebream/tila/releases/tag/v0.1.0
