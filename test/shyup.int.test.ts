import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startHarness, type Harness } from "./harness.ts";

let app: Harness;
beforeAll(async () => {
  app = await startHarness();
  await app.request("POST", "/api/projects", { key: "WEM", name: "WeMail" });
});
afterAll(() => app.stop());

describe("REST API", () => {
  test("rejects requests without a valid token", async () => {
    const response = await fetch(`${app.url}/api/tasks`, { headers: { Authorization: "Bearer sy_nope" } });
    expect(response.status).toBe(401);
  });

  test("creates, updates, comments on and closes a task", async () => {
    const created = await app.request("POST", "/api/tasks", { project: "wem", title: "Add retries", priority: "high" });
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({ ref: "WEM-1", status: "todo", created_by: "tester" });

    const updated = await app.request("PATCH", "/api/tasks/WEM-1", {
      status: "doing",
      assignee: "claude@wemail",
      comment: "On it",
    });
    expect(updated.data).toMatchObject({ status: "doing", assignee: "claude@wemail", closed_at: null });

    await app.request("PATCH", "/api/tasks/WEM-1", { status: "done" });
    const detail = await app.request("GET", "/api/tasks/WEM-1");
    expect(detail.data.closed_at).not.toBeNull();
    expect(detail.data.comments).toEqual([expect.objectContaining({ author: "tester", body: "On it" })]);
    expect(detail.data.history[0].change).toEqual({ status: ["todo", "doing"], assignee: [null, "claude@wemail"] });
  });

  test("numbers tasks per project and filters open ones", async () => {
    const second = await app.request("POST", "/api/tasks", { project: "WEM", title: "Bounce handling" });
    expect(second.data.ref).toBe("WEM-2");
    const open = await app.request("GET", "/api/tasks?project=WEM&status=open");
    expect(open.data.tasks.map((t: { ref: string }) => t.ref)).toEqual(["WEM-2"]);
  });

  test("explains bad input", async () => {
    const noProject = await app.request("POST", "/api/tasks", { project: "NOPE", title: "x" });
    expect(noProject.status).toBe(400);
    expect(noProject.data.error).toContain("No project NOPE");
    const badStatus = await app.request("PATCH", "/api/tasks/WEM-2", { status: "finished" });
    expect(badStatus.status).toBe(400);
    expect((await app.request("GET", "/api/tasks/WEM-99")).status).toBe(404);
  });
});

describe("MCP", () => {
  async function rpc(method: string, params: unknown = {}) {
    const response = await app.request("POST", "/mcp", { jsonrpc: "2.0", id: 1, method, params });
    return response.data;
  }

  test("initializes and lists tools", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } });
    expect(init.result.protocolVersion).toBe("2025-06-18");
    const { result } = await rpc("tools/list");
    expect(result.tools.map((t: { name: string }) => t.name)).toContain("create_task");
  });

  test("an agent can create and close a task", async () => {
    const created = await rpc("tools/call", { name: "create_task", arguments: { project: "WEM", title: "From an agent" } });
    const ref = created.result.structuredContent.ref;
    const closed = await rpc("tools/call", { name: "close_task", arguments: { ref, comment: "Shipped in #12" } });
    expect(closed.result.structuredContent.status).toBe("done");
  });

  test("tool errors come back as isError results", async () => {
    const { result } = await rpc("tools/call", { name: "get_task", arguments: { ref: "WEM-404" } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("No task WEM-404");
  });
});

describe("CLI", () => {
  test("adds and lists tasks", () => {
    expect(app.run("add", "WEM", "Write", "the", "docs", "--priority", "low")).toMatch(/Created WEM-\d+/);
    expect(app.run("tasks", "--project", "WEM", "--status", "todo")).toContain("Write the docs");
  });
});

describe("web UI", () => {
  test("sends signed-out visitors to the login page and shows the board after login", async () => {
    const signedOut = await fetch(app.url, { redirect: "manual" });
    expect(signedOut.headers.get("location")).toBe("/login");

    const login = await fetch(`${app.url}/login`, {
      method: "POST",
      body: new URLSearchParams({ token: app.token }),
      redirect: "manual",
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const board = await (await fetch(app.url, { headers: { cookie } })).text();
    expect(board).toContain("Bounce handling");
  });
});
