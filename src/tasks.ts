import type { DatabaseSync } from "node:sqlite";
import { inTransaction, now } from "./db.ts";

export const statuses = ["todo", "doing", "blocked", "done", "dropped"] as const;
export const priorities = ["high", "normal", "low"] as const;
export type Status = (typeof statuses)[number];
export type Priority = (typeof priorities)[number];

const closedStatuses: readonly Status[] = ["done", "dropped"];

/** Bad input from a caller. Shown to them as-is (HTTP 400, MCP tool error, CLI message). */
export class InputError extends Error {}
export class NotFoundError extends Error {}

export type Project = { key: string; name: string; description: string; created_at: string };

export type Task = {
  ref: string; // "WEM-12"
  project: string;
  number: number;
  title: string;
  body: string;
  status: Status;
  priority: Priority;
  assignee: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

export type Comment = { author: string; body: string; created_at: string };
export type TaskEvent = { actor: string; change: Record<string, [unknown, unknown]>; created_at: string };
export type TaskDetail = Task & { comments: Comment[]; history: TaskEvent[] };

type TaskRow = Omit<Task, "ref"> & { id: number };

// ---- input validation ------------------------------------------------------

type Input = Record<string, unknown>;

function asInput(value: unknown): Input {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputError("Expected a JSON object");
  }
  return value as Input;
}

function text(input: Input, field: string, { required = false, max = 200 } = {}): string | undefined {
  const value = input[field];
  if (value === undefined || value === null) {
    if (required) throw new InputError(`"${field}" is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new InputError(`"${field}" must be a string`);
  const trimmed = value.trim();
  if (required && trimmed === "") throw new InputError(`"${field}" can't be empty`);
  if (trimmed.length > max) throw new InputError(`"${field}" is longer than ${max} characters`);
  return trimmed;
}

function oneOf<T extends string>(input: Input, field: string, allowed: readonly T[]): T | undefined {
  const value = input[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new InputError(`"${field}" must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

// "" or null clears the assignee; undefined leaves it alone.
function assigneeField(input: Input): string | null | undefined {
  if (input.assignee === null) return null;
  const value = text(input, "assignee", { max: 64 });
  return value === "" ? null : value;
}

const bodyMax = 20_000;

// ---- projects --------------------------------------------------------------

export function createProject(db: DatabaseSync, raw: unknown): Project {
  const input = asInput(raw);
  const key = text(input, "key", { required: true, max: 10 })!.toUpperCase();
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key)) {
    throw new InputError('"key" must be 2-10 letters or digits, starting with a letter, like "WEM"');
  }
  const name = text(input, "name", { required: true })!;
  const description = text(input, "description", { max: 2000 }) ?? "";
  if (db.prepare("SELECT 1 FROM projects WHERE key = ?").get(key)) {
    throw new InputError(`Project ${key} already exists`);
  }
  const createdAt = now();
  db.prepare("INSERT INTO projects (key, name, description, created_at) VALUES (?, ?, ?, ?)").run(
    key,
    name,
    description,
    createdAt,
  );
  return { key, name, description, created_at: createdAt };
}

export function listProjects(db: DatabaseSync): Project[] {
  return db.prepare("SELECT key, name, description, created_at FROM projects ORDER BY key").all() as Project[];
}

// ---- tasks -----------------------------------------------------------------

function toTask(row: TaskRow): Task {
  const { id: _id, ...task } = row;
  return { ref: `${row.project}-${row.number}`, ...task };
}

function parseRef(ref: string): { project: string; number: number } {
  const match = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d+)$/.exec(ref.trim());
  if (!match) throw new InputError(`"${ref}" isn't a task ref like WEM-12`);
  return { project: match[1]!.toUpperCase(), number: Number(match[2]) };
}

function findRow(db: DatabaseSync, ref: string): TaskRow {
  const { project, number } = parseRef(ref);
  const row = db.prepare("SELECT * FROM tasks WHERE project = ? AND number = ?").get(project, number);
  if (!row) throw new NotFoundError(`No task ${project}-${number}`);
  return row as TaskRow;
}

export function createTask(db: DatabaseSync, actor: string, raw: unknown): Task {
  const input = asInput(raw);
  const projectKey = text(input, "project", { required: true, max: 10 })!.toUpperCase();
  const title = text(input, "title", { required: true })!;
  const body = text(input, "body", { max: bodyMax }) ?? "";
  const status = oneOf(input, "status", statuses) ?? "todo";
  const priority = oneOf(input, "priority", priorities) ?? "normal";
  const assignee = assigneeField(input) ?? null;

  return inTransaction(db, () => {
    const project = db.prepare("SELECT next_number FROM projects WHERE key = ?").get(projectKey) as
      | { next_number: number }
      | undefined;
    if (!project) throw new InputError(`No project ${projectKey}. Projects: ${projectKeys(db)}`);
    const number = project.next_number;
    db.prepare("UPDATE projects SET next_number = ? WHERE key = ?").run(number + 1, projectKey);
    const createdAt = now();
    const closedAt = closedStatuses.includes(status) ? createdAt : null;
    db.prepare(
      `INSERT INTO tasks (project, number, title, body, status, priority, assignee, created_by, created_at, updated_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(projectKey, number, title, body, status, priority, assignee, actor, createdAt, createdAt, closedAt);
    return getTask(db, `${projectKey}-${number}`);
  });
}

function projectKeys(db: DatabaseSync): string {
  return listProjects(db).map((p) => p.key).join(", ") || "none yet";
}

export function getTask(db: DatabaseSync, ref: string): Task {
  return toTask(findRow(db, ref));
}

export function getTaskDetail(db: DatabaseSync, ref: string): TaskDetail {
  const row = findRow(db, ref);
  const comments = db
    .prepare("SELECT author, body, created_at FROM comments WHERE task_id = ? ORDER BY id")
    .all(row.id) as Comment[];
  const history = (
    db.prepare("SELECT actor, change, created_at FROM events WHERE task_id = ? ORDER BY id").all(row.id) as {
      actor: string;
      change: string;
      created_at: string;
    }[]
  ).map((event) => ({ ...event, change: JSON.parse(event.change) as TaskEvent["change"] }));
  return { ...toTask(row), comments, history };
}

export type TaskFilter = {
  project?: string;
  status?: string;
  assignee?: string;
  query?: string;
  limit?: number;
  sort?: "priority" | "recent"; // recent = last updated first
};

const priorityOrder = "CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END";

export function listTasks(db: DatabaseSync, filter: TaskFilter = {}): Task[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.project) {
    where.push("project = ?");
    params.push(filter.project.toUpperCase());
  }
  if (filter.status === "open") {
    where.push("status NOT IN ('done', 'dropped')");
  } else if (filter.status) {
    const status = oneOf({ status: filter.status }, "status", statuses);
    where.push("status = ?");
    params.push(status!);
  }
  if (filter.assignee) {
    where.push("assignee = ?");
    params.push(filter.assignee);
  }
  if (filter.query) {
    where.push("(title LIKE ? OR body LIKE ?)");
    params.push(`%${filter.query}%`, `%${filter.query}%`);
  }
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY ${filter.sort === "recent" ? "updated_at DESC" : `${priorityOrder}, created_at`} LIMIT ${limit}`;
  return (db.prepare(sql).all(...params) as TaskRow[]).map(toTask);
}

/** Updates fields on a task. An optional "comment" is added in the same change. */
export function updateTask(db: DatabaseSync, actor: string, ref: string, raw: unknown): Task {
  const input = asInput(raw);
  const updates: Partial<Pick<Task, "title" | "body" | "status" | "priority" | "assignee">> = {
    title: text(input, "title"),
    body: text(input, "body", { max: bodyMax }),
    status: oneOf(input, "status", statuses),
    priority: oneOf(input, "priority", priorities),
    assignee: assigneeField(input),
  };
  if (updates.title === "") throw new InputError('"title" can\'t be empty');
  const comment = text(input, "comment", { max: bodyMax });

  return inTransaction(db, () => {
    const row = findRow(db, ref);
    const change: TaskEvent["change"] = {};
    for (const [field, value] of Object.entries(updates)) {
      const before = row[field as keyof TaskRow];
      if (value !== undefined && value !== before) change[field] = [before, value];
    }
    const timestamp = now();
    if (Object.keys(change).length > 0) {
      const next = { ...row, ...Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined)) };
      const wasClosed = closedStatuses.includes(row.status);
      const isClosed = closedStatuses.includes(next.status);
      const closedAt = isClosed ? (wasClosed ? row.closed_at : timestamp) : null;
      db.prepare(
        `UPDATE tasks SET title = ?, body = ?, status = ?, priority = ?, assignee = ?, updated_at = ?, closed_at = ?
         WHERE id = ?`,
      ).run(next.title, next.body, next.status, next.priority, next.assignee, timestamp, closedAt, row.id);
      db.prepare("INSERT INTO events (task_id, actor, change, created_at) VALUES (?, ?, ?, ?)").run(
        row.id,
        actor,
        JSON.stringify(change),
        timestamp,
      );
    }
    if (comment) insertComment(db, row.id, actor, comment, timestamp);
    return getTask(db, ref);
  });
}

export function addComment(db: DatabaseSync, actor: string, ref: string, raw: unknown): Comment {
  const body = text(asInput(raw), "body", { required: true, max: bodyMax })!;
  return inTransaction(db, () => {
    const row = findRow(db, ref);
    const timestamp = now();
    insertComment(db, row.id, actor, body, timestamp);
    return { author: actor, body, created_at: timestamp };
  });
}

function insertComment(db: DatabaseSync, taskId: number, author: string, body: string, timestamp: string): void {
  db.prepare("INSERT INTO comments (task_id, author, body, created_at) VALUES (?, ?, ?, ?)").run(
    taskId,
    author,
    body,
    timestamp,
  );
  db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(timestamp, taskId);
}
