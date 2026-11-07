// Runs the real CLI and server as child processes against a throwaway database.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dirname, "..", "src", "cli.ts");

export type Harness = {
  url: string;
  token: string;
  run: (...args: string[]) => string;
  request: (method: string, path: string, body?: unknown) => Promise<{ status: number; data: any }>;
  stop: () => void;
};

export async function startHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "shyup-test-"));
  const env = { ...process.env, SHYUP_DB: join(dir, "test.db"), PORT: "0", HOST: "127.0.0.1" };
  const runLocal = (...args: string[]) => execFileSync("node", [cli, ...args], { env, encoding: "utf8" });

  const token = runLocal("token", "create", "tester").trim().split("\n").at(-1)!;
  const server = spawn("node", [cli, "serve"], { env });
  const url = await waitForUrl(server);

  return {
    url,
    token,
    run: (...args) =>
      execFileSync("node", [cli, ...args], {
        env: { ...env, SHYUP_URL: url, SHYUP_TOKEN: token },
        encoding: "utf8",
      }),
    request: async (method, path, body) => {
      const response = await fetch(url + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, data: text ? JSON.parse(text) : null };
    },
    stop: () => {
      server.kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function waitForUrl(server: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    server.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = /listening on (http:\/\/\S+)/.exec(output);
      if (match) resolve(match[1]!);
    });
    server.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()));
    server.on("exit", (code) => reject(new Error(`Server exited (${code}):\n${output}`)));
  });
}
