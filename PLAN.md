# Shyup — Plan

A task manager for a company where AI agents do much of the work. Simpler than Jira: projects, tasks, comments, history. Agents and humans use the same API.

## Principles

- One process, one SQLite file, zero runtime dependencies. Easy to read, easy to host, easy to back up.
- Every action is attributed to a named token, and every change is in the history.
- Agents are first-class: MCP and CLI are as complete as the web board.
- Grow only when using it shows a real need.

## Phase 1 — First version

1. [x] SQLite schema with migrations: projects, tasks, comments, events, tokens.
2. [x] Tasks: create, list (filter by project, status, assignee, text), get, update, comment, close. Refs like `WEM-12`.
3. [x] Named tokens, hashed at rest; create, list and revoke from the CLI.
4. [x] REST API under `/api`.
5. [x] MCP server at `/mcp` (Streamable HTTP, JSON responses).
6. [x] CLI for admins (local DB) and clients (HTTP).
7. [x] Web board: sign in with a token, board per project, task page with update and comment forms, new-task form.
8. [x] Integration tests over the real CLI and server.
9. [x] Deploy guide: systemd + Caddy, and Docker.

## Phase 2 — Use it for real

1. [ ] Deploy our instance and move Status Labs work into it (projects from Weeoh's `software/manifest.yaml`).
2. [ ] Connect our agents over MCP, each with its own token.
3. [ ] Nightly SQLite backup (`sqlite3 .backup` or `VACUUM INTO`) to object storage, and a restore test.
4. [ ] Write down what hurts after two weeks of use; that list drives Phase 3.

## Phase 3 — Likely next (only if Phase 2 shows the need)

- Labels.
- Parent tasks / checklists for splitting work.
- Webhooks on task changes, so agents can react instead of polling.
- "Claim" that sets `doing` and assignee atomically, so two agents never take the same task.
- Search and filters on the web board.
- Token scopes (read-only, per project).
- Sync with GitHub Issues for public repos.
