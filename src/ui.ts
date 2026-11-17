// Server-rendered HTML for humans. Plain forms, no JavaScript.
import type { Project, Task, TaskDetail } from "./tasks.ts";
import { priorities, statuses } from "./tasks.ts";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const e = escapeHtml;

const styles = `
:root { --bg: #fafafa; --fg: #111; --muted: #666; --line: #ddd; --box: #fff; --accent: #e5484d; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0b0b0b; --fg: #eee; --muted: #999; --line: #333; --box: #151515; --accent: #ff6369; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 "Geist", ui-sans-serif, system-ui, sans-serif; }
a { color: inherit; }
header { position: sticky; top: 0; display: flex; gap: 16px; align-items: center; padding: 12px 16px;
  border-bottom: 2px solid var(--fg); background: color-mix(in srgb, var(--bg) 85%, transparent); backdrop-filter: blur(8px); }
header strong { font-size: 17px; }
header nav { display: flex; gap: 12px; overflow-x: auto; flex: 1; }
header nav a { text-decoration: none; padding: 10px 2px; color: var(--muted); white-space: nowrap; }
header nav a[aria-current] { color: var(--fg); border-bottom: 2px solid var(--accent); }
main { padding: 16px; max-width: 1200px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .05em; margin: 0 0 8px; }
.muted { color: var(--muted); font-size: 13px; }
.board { display: grid; gap: 16px; }
@media (min-width: 800px) { .board { grid-template-columns: repeat(4, 1fr); } }
.column { border: 1px solid var(--line); padding: 12px; background: var(--box); min-width: 0; }
.card { display: block; border: 1px solid var(--line); padding: 10px; margin-top: 8px; text-decoration: none; background: var(--bg); }
.card:hover, .card:focus { border-color: var(--fg); }
.tag { display: inline-block; font-size: 12px; border: 1px solid var(--line); padding: 0 6px; }
.tag.high { border-color: var(--accent); color: var(--accent); }
.box { border: 1px solid var(--line); background: var(--box); padding: 16px; margin-bottom: 16px; }
.body { white-space: pre-wrap; overflow-wrap: anywhere; }
form { display: grid; gap: 8px; }
.row { display: grid; gap: 8px; } @media (min-width: 600px) { .row { grid-template-columns: repeat(3, 1fr); } }
label { font-size: 13px; color: var(--muted); display: grid; gap: 4px; }
input, select, textarea, button { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line);
  border-radius: 0; padding: 10px; min-height: 44px; width: 100%; }
textarea { min-height: 88px; }
button { background: var(--fg); color: var(--bg); border-color: var(--fg); cursor: pointer; width: auto; justify-self: start; padding: 10px 18px; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.error { border: 2px solid var(--accent); padding: 10px; margin-bottom: 16px; }
ul.log { list-style: none; padding: 0; margin: 0; } ul.log li { border-top: 1px solid var(--line); padding: 10px 0; }
`;

function page(title: string, content: string, nav = ""): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)} · Shyup</title><style>${styles}</style></head>
<body><header><strong><a href="/" style="text-decoration:none">🤫 Shyup</a></strong><nav>${nav}</nav></header>
<main>${content}</main></body></html>`;
}

function projectNav(projects: Project[], current?: string): string {
  return projects
    .map((p) => `<a href="/?project=${e(p.key)}"${p.key === current ? ' aria-current="page"' : ""}>${e(p.key)}</a>`)
    .join("");
}

function options(values: readonly string[], selected: string): string {
  return values.map((v) => `<option${v === selected ? " selected" : ""}>${e(v)}</option>`).join("");
}

export function loginPage(state: { sent?: boolean; error?: string } = {}): string {
  const content = state.sent
    ? `<h1>Check your email</h1>
       <p>If that address has an account, a sign-in link is on its way. It works once and expires in 15 minutes.</p>
       <p><a href="/login">Use a different address</a></p>`
    : `<h1>Sign in</h1>
       <p class="muted">We'll email you a link. No password needed.</p>
       ${state.error ? `<div class="error" role="alert">${e(state.error)}</div>` : ""}
       <form method="post" action="/login">
         <label>Email <input name="email" type="email" autocomplete="email" required></label>
         <button>Email me a link</button>
       </form>
       <p class="muted">No account? Ask an admin to run <code>shyup user add &lt;name&gt; &lt;email&gt;</code>.</p>`;
  return page("Sign in", `<div class="box" style="max-width:420px">${content}</div>`);
}

export function signInPage(token: string): string {
  return page(
    "Sign in",
    `<div class="box" style="max-width:420px"><h1>Almost in</h1>
      <form method="post" action="/login/verify">
        <input type="hidden" name="token" value="${e(token)}">
        <button>Sign in to Shyup</button>
      </form></div>`,
  );
}

export function boardPage(projects: Project[], project: Project | undefined, tasks: Task[], actor: string): string {
  if (!project) {
    return page(
      "No projects",
      `<div class="box"><h1>No projects yet</h1>
      <p>Create one with <code>shyup project create WEM "WeMail"</code>, or ask your agent to call <code>create_project</code>.</p></div>`,
    );
  }
  const columns = (["todo", "doing", "blocked", "done"] as const)
    .map((status) => {
      const inColumn = tasks.filter((t) => t.status === status);
      const count = status === "done" ? "recent" : String(inColumn.length);
      return `<section class="column"><h2>${status} <span class="muted">${count}</span></h2>
        ${inColumn.map(card).join("") || '<p class="muted">Nothing here.</p>'}</section>`;
    })
    .join("");
  return page(
    project.name,
    `<h1>${e(project.name)}</h1><p class="muted">${e(project.description)} Signed in as ${e(actor)} · <a href="/logout">sign out</a></p>
    <div class="board">${columns}</div>
    <details class="box" style="margin-top:16px"><summary>New task</summary>
      <form method="post" action="/new" style="margin-top:12px">
        <input type="hidden" name="project" value="${e(project.key)}">
        <label>Title <input name="title" required maxlength="200"></label>
        <label>Details <textarea name="body"></textarea></label>
        <div class="row">
          <label>Priority <select name="priority">${options(priorities, "normal")}</select></label>
          <label>Assignee <input name="assignee" maxlength="64"></label>
        </div>
        <button>Create task</button>
      </form></details>`,
    projectNav(projects, project.key),
  );
}

function card(task: Task): string {
  return `<a class="card" href="/t/${e(task.ref)}"><span class="muted">${e(task.ref)}</span>
    ${task.priority !== "normal" ? `<span class="tag ${task.priority}">${task.priority}</span>` : ""}
    <div>${e(task.title)}</div>${task.assignee ? `<div class="muted">${e(task.assignee)}</div>` : ""}</a>`;
}

export function taskPage(projects: Project[], task: TaskDetail, error?: string): string {
  const history = task.history
    .map(
      (event) =>
        `<li><span class="muted">${e(event.created_at.slice(0, 16).replace("T", " "))} · ${e(event.actor)}</span><br>` +
        Object.entries(event.change)
          .map(([field, [from, to]]) => `${e(field)}: ${e(String(from ?? "–"))} → ${e(String(to ?? "–"))}`)
          .join(", ") +
        "</li>",
    )
    .join("");
  const comments = task.comments
    .map(
      (c) =>
        `<li><span class="muted">${e(c.created_at.slice(0, 16).replace("T", " "))} · ${e(c.author)}</span>
         <div class="body">${e(c.body)}</div></li>`,
    )
    .join("");
  return page(
    `${task.ref} ${task.title}`,
    `${error ? `<div class="error" role="alert">${e(error)}</div>` : ""}
    <div class="box">
      <p class="muted"><a href="/?project=${e(task.project)}">${e(task.project)}</a> / ${e(task.ref)} ·
        opened by ${e(task.created_by)} ${e(task.created_at.slice(0, 10))}</p>
      <h1>${e(task.title)}</h1>
      <p><span class="tag">${task.status}</span> <span class="tag ${task.priority}">${task.priority}</span>
        ${task.assignee ? `<span class="tag">${e(task.assignee)}</span>` : '<span class="muted">unassigned</span>'}</p>
      <div class="body">${e(task.body) || '<span class="muted">No details.</span>'}</div>
    </div>
    <div class="box"><h2>Update</h2>
      <form method="post" action="/t/${e(task.ref)}">
        <div class="row">
          <label>Status <select name="status">${options(statuses, task.status)}</select></label>
          <label>Priority <select name="priority">${options(priorities, task.priority)}</select></label>
          <label>Assignee <input name="assignee" value="${e(task.assignee ?? "")}" maxlength="64"></label>
        </div>
        <label>Comment <textarea name="comment"></textarea></label>
        <button>Save</button>
      </form></div>
    <div class="box"><h2>Comments</h2>${comments ? `<ul class="log">${comments}</ul>` : '<p class="muted">No comments yet.</p>'}</div>
    <div class="box"><h2>History</h2>${history ? `<ul class="log">${history}</ul>` : '<p class="muted">No changes yet.</p>'}</div>`,
    projectNav(projects, task.project),
  );
}

export function notFoundPage(message: string): string {
  return page("Not found", `<div class="box"><h1>Not found</h1><p>${e(message)}</p><p><a href="/">Back to the board</a></p></div>`);
}
