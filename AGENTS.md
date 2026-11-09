# AGENTS.md

Shyup: a small task manager for humans and AI agents. REST API, CLI, MCP server and web board on one SQLite file.

## Company context

This is a Status Labs product. Status Labs team members and agents: before starting, read Weeoh, the company brain, at https://github.com/Status-Labs/weeoh (private; start with its `AGENTS.md`). If it's checked out locally, it's at `../weeoh`. Track your work in Shyup under project `SHY`.

Outside contributors can skip this; everything you need is in this repo.

## Keep it simple

- No runtime dependencies. Node built-ins only (`node:http`, `node:sqlite`, `node:util`). Adding one needs a reason in `PLAN.md`.
- TypeScript that Node runs directly: erasable syntax only (no enums, no parameter properties, no namespaces), `.ts` in imports.
- One process, one database file. Don't add a queue, cache or second service.
- Smallest change that solves the task.

## Layout

| File | What |
| --- | --- |
| `src/cli.ts` | Entry point: `serve`, admin commands (local DB) and client commands (HTTP) |
| `src/server.ts` | HTTP routing: REST under `/api`, MCP at `/mcp`, web UI everywhere else |
| `src/tasks.ts` | Projects, tasks, comments, history. All validation lives here |
| `src/mcp.ts` | MCP tools: thin wrappers over `tasks.ts` |
| `src/ui.ts` | Server-rendered HTML. No client JavaScript |
| `src/tokens.ts` | Agent tokens for the API and MCP: create, check, revoke. Only hashes are stored |
| `src/users.ts` | People, emailed sign-in links and web sessions. Only hashes are stored |
| `src/mail.ts` | Sends sign-in emails through WeMail, or prints the link when email isn't set up |
| `src/db.ts` | Open SQLite and run migrations |

## Rules

- Schema changes: append a new entry to `migrations` in `src/db.ts`. Never edit an old one.
- A new feature reaches every interface that needs it: `tasks.ts`, then REST, MCP and CLI as it makes sense.
- Error messages are for humans and agents: say what's wrong and how to fix it.
- Escape everything rendered in `ui.ts` with `escapeHtml`.

## Working through the plan

- Find the current step: first unticked box in `PLAN.md`. One step per branch.
- Tick it in the same change once `just check` passes.

## Commands

- `just dev`: server on :4000 with reload.
- `just shyup <args>`: run the CLI.
- `just check`: typecheck and tests. Tests run the real CLI and server against a temp database (`test/harness.ts`).
