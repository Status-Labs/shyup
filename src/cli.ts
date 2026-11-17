#!/usr/bin/env node
import { parseArgs } from "node:util";
import { openDatabase } from "./db.ts";
import { startServer } from "./server.ts";
import { InputError, createProject, type Task, type TaskDetail } from "./tasks.ts";
import { createToken, listTokens, revokeToken } from "./tokens.ts";
import { addUser, listUsers, removeUser } from "./users.ts";
import { mailConfigFromEnv } from "./mail.ts";

const help = `shyup: a small task manager for humans and AI agents

Server (run on the machine with the database):
  shyup serve                         Start the server (PORT, HOST, SHYUP_DB)
  shyup token create <name>           Make a token; <name> is who it acts as, e.g. claude@wemail
  shyup token list
  shyup token revoke <name>
  shyup project create <KEY> <name> [--description text]
  shyup user add <name> <email>         Let someone sign in to the web board by email
  shyup user list
  shyup user remove <name>

Client (needs SHYUP_URL and SHYUP_TOKEN):
  shyup projects
  shyup tasks [--project K] [--status S|open] [--assignee A] [--query text] [--json]
  shyup show <REF> [--json]
  shyup add <KEY> <title> [--body text] [--priority high|normal|low] [--assignee A]
  shyup update <REF> [--status S] [--priority P] [--assignee A] [--title T] [--body B] [--comment C]
  shyup comment <REF> <text>
  shyup close <REF> <comment> [--dropped]

Statuses: todo, doing, blocked, done, dropped.`;

const options = {
  project: { type: "string" },
  status: { type: "string" },
  assignee: { type: "string" },
  query: { type: "string" },
  priority: { type: "string" },
  title: { type: "string" },
  body: { type: "string" },
  comment: { type: "string" },
  description: { type: "string" },
  dropped: { type: "boolean" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true });
  const [command, ...rest] = positionals;
  if (!command || values.help) return console.log(help);

  switch (command) {
    case "serve":
      return serve();
    case "token":
      return token(rest);
    case "user":
      return user(rest);
    case "project":
      return project(rest, values.description);
    case "projects": {
      const { projects } = (await api("GET", "/api/projects")) as { projects: { key: string; name: string }[] };
      for (const p of projects) console.log(`${p.key.padEnd(8)} ${p.name}`);
      return;
    }
    case "tasks": {
      const query = new URLSearchParams();
      for (const field of ["project", "status", "assignee"] as const) if (values[field]) query.set(field, values[field]);
      if (values.query) query.set("q", values.query);
      const { tasks } = (await api("GET", `/api/tasks?${query}`)) as { tasks: Task[] };
      if (values.json) return printJson(tasks);
      if (tasks.length === 0) return console.log("No tasks.");
      for (const t of tasks) printTaskLine(t);
      return;
    }
    case "show": {
      const task = (await api("GET", `/api/tasks/${need(rest[0], "REF")}`)) as TaskDetail;
      if (values.json) return printJson(task);
      return printTask(task);
    }
    case "add": {
      const task = (await api("POST", "/api/tasks", {
        project: need(rest[0], "KEY"),
        title: need(rest.slice(1).join(" "), "title"),
        body: values.body,
        priority: values.priority,
        assignee: values.assignee,
      })) as Task;
      return values.json ? printJson(task) : console.log(`Created ${task.ref}`);
    }
    case "update": {
      const task = (await api("PATCH", `/api/tasks/${need(rest[0], "REF")}`, {
        status: values.status,
        priority: values.priority,
        assignee: values.assignee,
        title: values.title,
        body: values.body,
        comment: values.comment,
      })) as Task;
      return values.json ? printJson(task) : printTaskLine(task);
    }
    case "comment": {
      await api("POST", `/api/tasks/${need(rest[0], "REF")}/comments`, { body: need(rest.slice(1).join(" "), "text") });
      return console.log("Comment added.");
    }
    case "close": {
      const task = (await api("PATCH", `/api/tasks/${need(rest[0], "REF")}`, {
        status: values.dropped ? "dropped" : "done",
        comment: need(rest.slice(1).join(" "), "comment"),
      })) as Task;
      return console.log(`Closed ${task.ref} as ${task.status}.`);
    }
    default:
      throw new InputError(`Unknown command "${command}". Run shyup --help.`);
  }
}

function databasePath(): string {
  return process.env.SHYUP_DB ?? "data/shyup.db";
}

async function serve(): Promise<void> {
  const mail = mailConfigFromEnv(process.env);
  const baseUrl = process.env.SHYUP_BASE_URL?.replace(/\/$/, "") || null;
  // Emailed links must not be built from the request's Host header, which a client controls.
  if (mail && !baseUrl) throw new InputError("Set SHYUP_BASE_URL (e.g. https://tasks.example.com) when sending email.");
  const db = openDatabase(databasePath());
  const port = Number(process.env.PORT ?? 4000);
  const host = process.env.HOST ?? "127.0.0.1";
  const server = await startServer(db, { port, host, baseUrl, mail });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  console.log(`Shyup listening on http://${host}:${actualPort} (database: ${databasePath()})`);
  if (!mail) console.log("Email isn't configured: sign-in links are printed here.");
  const stop = () => server.close(() => (db.close(), process.exit(0)));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

function token([action, name]: string[]): void {
  const db = openDatabase(databasePath());
  if (action === "create") {
    const value = createToken(db, need(name, "name"));
    console.log(`Token for ${name} (shown once, store it somewhere safe):\n${value}`);
  } else if (action === "list") {
    for (const t of listTokens(db)) {
      const state = t.revoked_at ? `revoked ${t.revoked_at}` : `last used ${t.last_used_at ?? "never"}`;
      console.log(`${t.name.padEnd(24)} ${state}`);
    }
  } else if (action === "revoke") {
    revokeToken(db, need(name, "name"));
    console.log(`Revoked ${name}.`);
  } else {
    throw new InputError("Usage: shyup token create|list|revoke <name>");
  }
}

function user([action, name, email]: string[]): void {
  const db = openDatabase(databasePath());
  if (action === "add") {
    const added = addUser(db, need(name, "name"), need(email, "email"));
    console.log(`Added ${added.name} <${added.email}>. They can sign in at /login.`);
  } else if (action === "list") {
    for (const u of listUsers(db)) console.log(`${u.name.padEnd(24)} ${u.email}`);
  } else if (action === "remove") {
    removeUser(db, need(name, "name"));
    console.log(`Removed ${name} and signed them out.`);
  } else {
    throw new InputError("Usage: shyup user add <name> <email> | list | remove <name>");
  }
}

function project([action, key, ...name]: string[], description: string | undefined): void {
  if (action !== "create") throw new InputError("Usage: shyup project create <KEY> <name>");
  const created = createProject(openDatabase(databasePath()), { key, name: name.join(" "), description });
  console.log(`Created project ${created.key}.`);
}

async function api(method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
  const baseUrl = process.env.SHYUP_URL;
  const tokenValue = process.env.SHYUP_TOKEN;
  if (!baseUrl || !tokenValue) throw new InputError("Set SHYUP_URL and SHYUP_TOKEN first.");
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: { Authorization: `Bearer ${tokenValue}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await response.json()) as { error?: string };
  if (!response.ok) throw new InputError(data.error ?? `Request failed: ${response.status}`);
  return data;
}

function need(value: string | undefined, what: string): string {
  if (!value) throw new InputError(`Missing ${what}. Run shyup --help.`);
  return value;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printTaskLine(t: Task): void {
  const flag = t.priority === "high" ? "!" : t.priority === "low" ? "↓" : " ";
  console.log(`${t.ref.padEnd(9)} ${flag} ${t.status.padEnd(8)} ${t.title}${t.assignee ? `  (${t.assignee})` : ""}`);
}

function printTask(t: TaskDetail): void {
  console.log(`${t.ref}  ${t.title}`);
  console.log(`${t.status} · ${t.priority} · ${t.assignee ?? "unassigned"} · opened by ${t.created_by} ${t.created_at}`);
  if (t.body) console.log(`\n${t.body}`);
  for (const c of t.comments) console.log(`\n— ${c.author}, ${c.created_at}\n${c.body}`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof InputError || (error instanceof Error && error.name === "TypeError" && "code" in error)) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});
