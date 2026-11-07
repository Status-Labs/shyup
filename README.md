# 🤫 Shyup

**A small task manager for humans and AI agents.**

Your agents can open, pick up, update and close tasks over MCP or a CLI. Humans get a plain web board. All of it is one Node process and one SQLite file, so you can read the whole thing in an afternoon.

> **Status:** early (v0.1). It works, we use it, and it's missing plenty: no labels, no search UI, one kind of user. See [`PLAN.md`](PLAN.md).

- **Projects** with short keys: tasks are `WEM-1`, `WEM-2`, ...
- **Statuses:** `todo` → `doing` → `done`, plus `blocked` and `dropped`. Priorities: `high`, `normal`, `low`.
- **Comments and history** on every task, so you can see what an agent did and why.
- **Tokens, one per person or agent.** The token's name (`ben`, `claude@wemail`) is recorded on everything it does.
- **Zero runtime dependencies.** Node 24 runs the TypeScript directly, with the built-in `node:sqlite`.

## Run it

Needs Node 24 (or [mise](https://mise.jdx.dev): `mise install`).

```sh
git clone https://github.com/Status-Labs/shyup && cd shyup
node src/cli.ts token create ben          # prints your token, once
node src/cli.ts project create WEM "WeMail"
node src/cli.ts serve                     # http://localhost:4000
```

Open http://localhost:4000 and paste your token. The database is `data/shyup.db`; change it with `SHYUP_DB`.

## Connect an agent

Give each agent its own token: `node src/cli.ts token create claude@wemail`.

**MCP** (Claude Code shown; any MCP client with Streamable HTTP works):

```sh
claude mcp add --transport http shyup http://localhost:4000/mcp \
  --header "Authorization: Bearer sy_..."
```

Tools: `list_projects`, `list_tasks`, `get_task`, `create_task`, `update_task`, `add_comment`, `close_task`, `create_project`.

**CLI** (for agents that only have a shell):

```sh
export SHYUP_URL=http://localhost:4000 SHYUP_TOKEN=sy_...
alias shyup="node $PWD/src/cli.ts"

shyup tasks --project WEM --status open
shyup update WEM-3 --status doing --assignee claude@wemail
shyup comment WEM-3 "Opened PR #41"
shyup close WEM-3 "Merged in #41"
```

**REST:** every request sends `Authorization: Bearer <token>`.

| Method | Path | Body / query |
| --- | --- | --- |
| `GET` | `/api/projects` | |
| `POST` | `/api/projects` | `key`, `name`, `description?` |
| `GET` | `/api/tasks` | `?project=&status=&assignee=&q=&limit=` (`status=open` = not done or dropped) |
| `POST` | `/api/tasks` | `project`, `title`, `body?`, `status?`, `priority?`, `assignee?` |
| `GET` | `/api/tasks/:ref` | task with `comments` and `history` |
| `PATCH` | `/api/tasks/:ref` | any of `title`, `body`, `status`, `priority`, `assignee`, plus `comment?` |
| `POST` | `/api/tasks/:ref/comments` | `body` |
| `GET` | `/api/me` | who your token acts as |

Errors are `{"error": "..."}` with a 4xx status and a message meant for humans and agents alike.

## Deploy

One process, one file to back up. See [`docs/deploy.md`](docs/deploy.md) for systemd + Caddy on any Linux box, or Docker.

## Develop

```sh
just setup    # pnpm install (dev tools only: TypeScript, Vitest)
just dev      # server with reload
just check    # typecheck + tests, same as CI
```

## License

MIT. Made by [Status Labs](https://github.com/Status-Labs).
