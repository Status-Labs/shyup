import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
  async function requestLink(email: string) {
    const response = await fetch(`${app.url}/login`, { method: "POST", body: new URLSearchParams({ email }) });
    return { status: response.status, html: await response.text() };
  }

  test("signs in with an emailed link that works once", async () => {
    app.admin("user", "add", "ada", "Ada@Example.com");
    const signedOut = await fetch(app.url, { redirect: "manual" });
    expect(signedOut.headers.get("location")).toBe("/login");

    expect((await requestLink("ada@example.com")).html).toContain("Check your email");
    const link = /Sign-in link for ada@example.com: (\S+)/.exec(app.log())![1]!;
    const token = new URL(link).searchParams.get("token")!;

    // Opening the link alone (as a mail scanner would) doesn't use it up.
    expect((await fetch(link)).status).toBe(200);
    const signIn = () =>
      fetch(`${app.url}/login/verify`, { method: "POST", body: new URLSearchParams({ token }), redirect: "manual" });
    const first = await signIn();
    const cookie = first.headers.get("set-cookie")!.split(";")[0]!;
    const board = await (await fetch(app.url, { headers: { cookie } })).text();
    expect(board).toContain("Signed in as ada");
    expect((await signIn()).status).toBe(400);
  });

  test("answers the same for unknown addresses and sends nothing", async () => {
    const before = app.log();
    expect((await requestLink("nobody@example.com")).html).toContain("Check your email");
    expect(app.log()).toBe(before);
  });
});

describe("sign-in email through WeMail", () => {
  test("sends the link with the configured inbox and base URL", async () => {
    const sent: { auth: string | undefined; body: Record<string, string> }[] = [];
    const fakeWemail = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      sent.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
      res.writeHead(201, { "Content-Type": "application/json" }).end('{"id":"msg_1"}');
    });
    await new Promise<void>((resolve) => fakeWemail.listen(0, "127.0.0.1", resolve));
    const { port } = fakeWemail.address() as AddressInfo;
    const mailed = await startHarness({
      SHYUP_BASE_URL: "https://tasks.example.com",
      SHYUP_WEMAIL_URL: `http://127.0.0.1:${port}`,
      SHYUP_WEMAIL_API_KEY: "wm_test",
      SHYUP_WEMAIL_INBOX_ID: "ibx_1",
    });
    try {
      mailed.admin("user", "add", "ben", "ben@example.com");
      await fetch(`${mailed.url}/login`, { method: "POST", body: new URLSearchParams({ email: "ben@example.com" }) });
      expect(sent).toHaveLength(1);
      expect(sent[0]!.auth).toBe("Bearer wm_test");
      expect(sent[0]!.body).toMatchObject({ inbox_id: "ibx_1", to: "ben@example.com" });
      expect(sent[0]!.body.text).toContain("https://tasks.example.com/login/verify?token=");
    } finally {
      mailed.stop();
      fakeWemail.close();
    }
  });
});
