// A minimal MCP server over Streamable HTTP: one JSON-RPC request per POST, answered with plain JSON.
// Spec: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
import type { DatabaseSync } from "node:sqlite";
import {
  InputError,
  NotFoundError,
  addComment,
  createProject,
  createTask,
  getTaskDetail,
  listProjects,
  listTasks,
  priorities,
  statuses,
  updateTask,
} from "./tasks.ts";

const supportedVersions = ["2025-06-18", "2025-03-26", "2024-11-05"];

const refProperty = { type: "string", description: "Task ref, like WEM-12" };
const editableProperties = {
  title: { type: "string" },
  body: { type: "string", description: "Markdown. What and why." },
  status: { type: "string", enum: statuses },
  priority: { type: "string", enum: priorities },
  assignee: { type: "string", description: 'Who is on it, e.g. "claude@wemail". Empty string to unassign.' },
};

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (db: DatabaseSync, actor: string, args: Record<string, unknown>) => unknown;
};

const tools: Tool[] = [
  {
    name: "list_projects",
    description: "List projects. Each product has one; its key prefixes task refs (WEM-12).",
    inputSchema: { type: "object", properties: {} },
    run: (db) => ({ projects: listProjects(db) }),
  },
  {
    name: "list_tasks",
    description:
      'List tasks, highest priority first. Filter by project, status ("open" = not done or dropped), assignee or text.',
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        status: { type: "string", enum: [...statuses, "open"] },
        assignee: { type: "string" },
        query: { type: "string", description: "Text to find in title or body" },
        limit: { type: "number", description: "Max results, default 100" },
      },
    },
    run: (db, _actor, args) => ({
      tasks: listTasks(db, {
        project: optionalString(args.project),
        status: optionalString(args.status),
        assignee: optionalString(args.assignee),
        query: optionalString(args.query),
        limit: typeof args.limit === "number" ? args.limit : undefined,
      }),
    }),
  },
  {
    name: "get_task",
    description: "Get one task with its comments and change history.",
    inputSchema: { type: "object", properties: { ref: refProperty }, required: ["ref"] },
    run: (db, _actor, args) => getTaskDetail(db, requiredRef(args)),
  },
  {
    name: "create_task",
    description: "Create a task. Keep it to one outcome: a title that says what done looks like, a body with the why.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string", description: "Project key, like WEM" }, ...editableProperties },
      required: ["project", "title"],
    },
    run: (db, actor, args) => createTask(db, actor, args),
  },
  {
    name: "update_task",
    description:
      "Change a task's fields. Set status to doing when you start, blocked when stuck. Add a comment to explain the change.",
    inputSchema: {
      type: "object",
      properties: { ref: refProperty, ...editableProperties, comment: { type: "string" } },
      required: ["ref"],
    },
    run: (db, actor, args) => updateTask(db, actor, requiredRef(args), args),
  },
  {
    name: "add_comment",
    description: "Comment on a task: progress, findings, blockers, PR links.",
    inputSchema: {
      type: "object",
      properties: { ref: refProperty, body: { type: "string" } },
      required: ["ref", "body"],
    },
    run: (db, actor, args) => addComment(db, actor, requiredRef(args), args),
  },
  {
    name: "close_task",
    description: 'Close a task as done (default) or dropped, with a comment saying what was done or why it was dropped.',
    inputSchema: {
      type: "object",
      properties: {
        ref: refProperty,
        comment: { type: "string" },
        status: { type: "string", enum: ["done", "dropped"] },
      },
      required: ["ref", "comment"],
    },
    run: (db, actor, args) => {
      if (args.status !== undefined && args.status !== "done" && args.status !== "dropped") {
        throw new InputError('"status" must be done or dropped');
      }
      return updateTask(db, actor, requiredRef(args), {
        status: args.status ?? "done",
        comment: args.comment,
      });
    },
  },
  {
    name: "create_project",
    description: "Create a project. Only for a new product or area; check list_projects first.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "2-10 letters/digits, like WEM" },
        name: { type: "string" },
        description: { type: "string" },
      },
      required: ["key", "name"],
    },
    run: (db, _actor, args) => createProject(db, args),
  },
];

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function requiredRef(args: Record<string, unknown>): string {
  if (typeof args.ref !== "string") throw new InputError('"ref" is required');
  return args.ref;
}

type JsonRpcResponse = { jsonrpc: "2.0"; id: unknown; result?: unknown; error?: { code: number; message: string } };

/** Handles one JSON-RPC message. Returns null for notifications, which get no response. */
export function handleMcpMessage(db: DatabaseSync, actor: string, message: unknown): JsonRpcResponse | null {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
  }
  const { id, method, params } = message as { id?: unknown; method?: unknown; params?: unknown };
  if (id === undefined) return null;
  const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, text: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message: text } });
  const p = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;

  switch (method) {
    case "initialize": {
      const requested = typeof p.protocolVersion === "string" ? p.protocolVersion : "";
      return reply({
        protocolVersion: supportedVersions.includes(requested) ? requested : supportedVersions[0],
        capabilities: { tools: {} },
        serverInfo: { name: "shyup", version: "0.1.0" },
        instructions:
          "Shyup is the team's task manager. Find your project with list_projects, pick up work with list_tasks, " +
          "set status to doing when you start, comment as you go, and close_task when it's done.",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: tools.map(({ run: _run, ...definition }) => definition) });
    case "tools/call": {
      const tool = tools.find((t) => t.name === p.name);
      if (!tool) return fail(-32602, `Unknown tool: ${String(p.name)}`);
      const args = (typeof p.arguments === "object" && p.arguments !== null ? p.arguments : {}) as Record<
        string,
        unknown
      >;
      try {
        const result = tool.run(db, actor, args);
        return reply({
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        });
      } catch (error) {
        if (error instanceof InputError || error instanceof NotFoundError) {
          return reply({ content: [{ type: "text", text: error.message }], isError: true });
        }
        throw error;
      }
    }
    default:
      return fail(-32601, `Method not found: ${String(method)}`);
  }
}
