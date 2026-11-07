import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { handleMcpMessage } from "./mcp.ts";
import {
  InputError,
  NotFoundError,
  addComment,
  createProject,
  createTask,
  getTaskDetail,
  listProjects,
  listTasks,
  updateTask,
} from "./tasks.ts";
import { authenticate } from "./tokens.ts";
import { boardPage, loginPage, notFoundPage, taskPage } from "./ui.ts";

const maxBodyBytes = 1_000_000;
const cookieName = "shyup_token";

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function startServer(db: DatabaseSync, port: number, host = "127.0.0.1"): Promise<Server> {
  const server = createServer((req, res) => {
    handle(db, req, res).catch((error: unknown) => {
      const status = statusFor(error);
      if (status === 500) console.error(error);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? "Internal error" : (error as Error).message });
      else res.end();
    });
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

function statusFor(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  if (error instanceof InputError) return 400;
  if (error instanceof NotFoundError) return 404;
  return 500;
}

async function handle(db: DatabaseSync, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (path === "/healthz") return sendJson(res, 200, { ok: true });

  if (path === "/mcp") {
    if (method !== "POST") throw new HttpError(405, "Use POST for MCP");
    const actor = requireBearer(db, req);
    const response = handleMcpMessage(db, actor, await readJson(req));
    if (response === null) {
      res.writeHead(202).end();
      return;
    }
    return sendJson(res, 200, response);
  }

  if (path.startsWith("/api/")) return handleApi(db, req, res, method, path, url);
  return handleUi(db, req, res, method, path, url);
}

// ---- REST API ---------------------------------------------------------------

async function handleApi(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  url: URL,
): Promise<void> {
  const actor = requireBearer(db, req);
  const taskMatch = /^\/api\/tasks\/([^/]+)(\/comments)?$/.exec(path);
  const ref = taskMatch ? decodeURIComponent(taskMatch[1]!) : "";

  if (path === "/api/me" && method === "GET") return sendJson(res, 200, { name: actor });
  if (path === "/api/projects" && method === "GET") return sendJson(res, 200, { projects: listProjects(db) });
  if (path === "/api/projects" && method === "POST") return sendJson(res, 201, createProject(db, await readJson(req)));
  if (path === "/api/tasks" && method === "GET") {
    const q = url.searchParams;
    const tasks = listTasks(db, {
      project: q.get("project") ?? undefined,
      status: q.get("status") ?? undefined,
      assignee: q.get("assignee") ?? undefined,
      query: q.get("q") ?? undefined,
      limit: q.has("limit") ? Number(q.get("limit")) || undefined : undefined,
    });
    return sendJson(res, 200, { tasks });
  }
  if (path === "/api/tasks" && method === "POST") return sendJson(res, 201, createTask(db, actor, await readJson(req)));
  if (taskMatch && !taskMatch[2] && method === "GET") return sendJson(res, 200, getTaskDetail(db, ref));
  if (taskMatch && !taskMatch[2] && method === "PATCH") {
    return sendJson(res, 200, updateTask(db, actor, ref, await readJson(req)));
  }
  if (taskMatch && taskMatch[2] && method === "POST") {
    return sendJson(res, 201, addComment(db, actor, ref, await readJson(req)));
  }
  throw new HttpError(404, `No route ${method} ${path}`);
}

// ---- web UI -----------------------------------------------------------------

async function handleUi(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  url: URL,
): Promise<void> {
  if (path === "/login" && method === "GET") return sendHtml(res, 200, loginPage());
  if (path === "/login" && method === "POST") {
    const token = (await readForm(req)).get("token")?.trim() ?? "";
    if (!authenticate(db, token)) return sendHtml(res, 401, loginPage("That token isn't valid."));
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `${cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${secure}`);
    return redirect(res, "/");
  }
  if (path === "/logout") {
    res.setHeader("Set-Cookie", `${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return redirect(res, "/login");
  }

  const actor = cookieActor(db, req);
  if (!actor) return redirect(res, "/login");
  // Cookie-authed writes rely on SameSite=Lax; also reject cross-origin form posts outright.
  if (method === "POST" && !sameOrigin(req)) throw new HttpError(403, "Cross-origin request refused");

  if (path === "/" && method === "GET") {
    const projects = listProjects(db);
    const key = url.searchParams.get("project")?.toUpperCase();
    const project = projects.find((p) => p.key === key) ?? projects[0];
    const tasks = project
      ? [
          ...listTasks(db, { project: project.key, status: "open", limit: 500 }),
          ...listTasks(db, { project: project.key, status: "done", sort: "recent", limit: 20 }),
        ]
      : [];
    return sendHtml(res, 200, boardPage(projects, project, tasks, actor));
  }
  if (path === "/new" && method === "POST") {
    const form = await readForm(req);
    const task = createTask(db, actor, {
      project: form.get("project"),
      title: form.get("title"),
      body: form.get("body"),
      priority: form.get("priority"),
      assignee: form.get("assignee") ?? "",
    });
    return redirect(res, `/t/${task.ref}`);
  }
  const taskMatch = /^\/t\/([^/]+)$/.exec(path);
  if (taskMatch) {
    const ref = decodeURIComponent(taskMatch[1]!);
    try {
      if (method === "POST") {
        const form = await readForm(req);
        updateTask(db, actor, ref, {
          status: form.get("status"),
          priority: form.get("priority"),
          assignee: form.get("assignee") ?? "",
          comment: form.get("comment"),
        });
        return redirect(res, `/t/${ref}`);
      }
      return sendHtml(res, 200, taskPage(listProjects(db), getTaskDetail(db, ref)));
    } catch (error) {
      if (error instanceof NotFoundError) return sendHtml(res, 404, notFoundPage(error.message));
      if (error instanceof InputError) return sendHtml(res, 400, taskPage(listProjects(db), getTaskDetail(db, ref), error.message));
      throw error;
    }
  }
  return sendHtml(res, 404, notFoundPage(`Nothing at ${path}`));
}

// ---- helpers ----------------------------------------------------------------

function requireBearer(db: DatabaseSync, req: IncomingMessage): string {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const actor = token ? authenticate(db, token) : null;
  if (!actor) throw new HttpError(401, "Missing or invalid token. Send Authorization: Bearer <token>.");
  return actor;
}

function cookieActor(db: DatabaseSync, req: IncomingMessage): string | null {
  const cookies = req.headers.cookie ?? "";
  const match = new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`).exec(cookies);
  return match ? authenticate(db, match[1]!) : null;
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // Non-browser clients and older browsers don't send it.
  return new URL(origin).host === req.headers.host;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBodyBytes) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, "Body must be valid JSON");
  }
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readBody(req));
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(value));
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res
    .writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    })
    .end(html);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { Location: location }).end();
}
