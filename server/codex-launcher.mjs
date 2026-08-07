import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";

const REQUEST_TIMEOUT_MS = 30_000;

function launchError(message, detail = "") {
  const suffix = detail.trim() ? `：${detail.trim().slice(-1200)}` : "";
  return new Error(`${message}${suffix}`);
}

export class CodexLauncher {
  constructor(options = {}) {
    const userHome = homedir();
    const userInstall = join(userHome, ".npm-global", "bin", "codex");
    this.command = options.command || process.env.CODEX_BIN || (existsSync(userInstall) ? userInstall : "codex");
    this.env = { ...process.env, HOME: process.env.HOME || userHome, CODEX_HOME: process.env.CODEX_HOME || join(userHome, ".codex") };
    this.children = new Set();
  }

  async withClient(run) {
    const child = spawn(this.command, ["app-server", "--listen", "stdio://"], {
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.children.add(child);
    child.stdin.on("error", () => { /* request/exit handlers report the useful failure */ });

    let nextId = 1;
    let stderr = "";
    const pending = new Map();
    const lines = readline.createInterface({ input: child.stdout });
    const stop = () => {
      lines.close();
      if (!child.killed) child.kill();
      this.children.delete(child);
    };
    const rejectPending = (error) => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      pending.clear();
    };
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const request = (requestMethod, requestParams = {}) => new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(launchError(`Codex ${requestMethod} 超时`, stderr));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      send({ method: requestMethod, id, params: requestParams });
    });

    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8000); });
    lines.on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === undefined || !pending.has(message.id)) return;
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(launchError(message.error.message || "Codex 请求失败", stderr));
      else entry.resolve(message.result);
    });
    child.on("error", (error) => rejectPending(launchError("无法启动 Codex CLI", error.message)));
    child.on("exit", (code, signal) => {
      this.children.delete(child);
      if (pending.size) rejectPending(launchError(`Codex App Server 意外退出（${signal || code}）`, stderr));
    });

    try {
      await request("initialize", {
        clientInfo: { name: "codex_task_inventory", title: "Codex Task Inventory", version: "0.1.0" },
      });
      send({ method: "initialized", params: {} });
      return await run(request);
    } finally {
      stop();
    }
  }

  async requestOnce(method, params = {}) {
    return this.withClient((request) => request(method, params));
  }

  async listThreadNames({ threadIds } = {}) {
    const ids = [...new Set(threadIds || [])];
    if (!ids.length) return new Map();
    return this.withClient(async (request) => {
      const names = new Map();
      for (let offset = 0; offset < ids.length; offset += 20) {
        const batch = ids.slice(offset, offset + 20);
        const results = await Promise.all(batch.map((threadId) => request("thread/read", { threadId, includeTurns: false })));
        results.forEach((result, index) => names.set(batch[index], result?.thread?.name || null));
      }
      return names;
    });
  }

  async launch({ cwd, prompt }) {
    const child = spawn(this.command, ["app-server", "--listen", "stdio://"], {
      cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.children.add(child);
    child.stdin.on("error", () => { /* process error/exit handlers report the useful failure */ });

    let nextId = 1;
    let stderr = "";
    let settled = false;
    const pending = new Map();
    const lines = readline.createInterface({ input: child.stdout });

    const stop = () => {
      lines.close();
      if (!child.killed) child.kill();
      this.children.delete(child);
    };
    const rejectPending = (error) => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      pending.clear();
    };
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const notify = (method, params = {}) => send({ method, params });
    const request = (method, params = {}) => new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(launchError(`Codex ${method} 超时`, stderr));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      send({ method, id, params });
    });

    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8000); });
    lines.on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== undefined && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(launchError(message.error.message || "Codex 请求失败", stderr));
        else entry.resolve(message.result);
      }
      if (message.method === "turn/completed") {
        child.stdin.end();
        setTimeout(stop, 1000).unref();
      }
    });
    child.on("error", (error) => rejectPending(launchError("无法启动 Codex CLI", error.message)));
    child.on("exit", (code, signal) => {
      this.children.delete(child);
      if (pending.size) rejectPending(launchError(`Codex App Server 意外退出（${signal || code}）`, stderr));
    });

    try {
      await request("initialize", {
        clientInfo: { name: "codex_task_inventory", title: "Codex Task Inventory", version: "0.1.0" },
      });
      notify("initialized");
      const started = await request("thread/start", {
        cwd,
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandbox: "workspace-write",
        serviceName: "codex_task_inventory",
      });
      const threadId = started?.thread?.id;
      if (!threadId) throw launchError("Codex 未返回 thread ID", stderr);
      const turn = await request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt }],
      });
      const turnId = turn?.turn?.id;
      if (!turnId) throw launchError("Codex 未返回 turn ID", stderr);
      settled = true;
      return { threadId, turnId, deepLink: `codex://threads/${threadId}` };
    } catch (error) {
      stop();
      throw error;
    } finally {
      if (!settled && !child.killed) stop();
    }
  }

  close() {
    for (const child of this.children) {
      if (!child.killed) child.kill();
    }
    this.children.clear();
  }
}

export function buildTaskPrompt(task) {
  return [task.title, task.note].filter(Boolean).join("\n\n");
}
