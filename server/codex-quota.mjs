import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_CACHE_TTL_MS = 60_000;

function codexCommand(configured) {
  const userInstall = join(homedir(), ".npm-global", "bin", "codex");
  return configured || process.env.CODEX_BIN || (existsSync(userInstall) ? userInstall : "codex");
}

function quotaError(message, detail = "") {
  const suffix = detail.trim() ? `：${detail.trim().slice(-1200)}` : "";
  return new Error(`${message}${suffix}`);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeWindow(window) {
  if (!window || typeof window !== "object") return null;
  const usedPercent = finiteNumber(window.usedPercent);
  const resetsAtSeconds = finiteNumber(window.resetsAt);
  return {
    usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, Math.min(100, Math.round(100 - usedPercent))),
    windowDurationMins: finiteNumber(window.windowDurationMins),
    resetsAt: resetsAtSeconds === null ? null : new Date(resetsAtSeconds * 1000).toISOString(),
  };
}

export function normalizeRateLimits(result) {
  const fallback = result?.rateLimits || null;
  const buckets = result?.rateLimitsByLimitId;
  const bucket = buckets?.codex || (buckets && Object.values(buckets).find((item) => item?.limitId === "codex")) || fallback;
  return {
    available: Boolean(bucket?.primary),
    limitId: bucket?.limitId || null,
    limitName: bucket?.limitName || null,
    planType: bucket?.planType || null,
    primary: normalizeWindow(bucket?.primary),
    secondary: normalizeWindow(bucket?.secondary),
    fetchedAt: new Date().toISOString(),
  };
}

export class CodexQuotaReader {
  constructor(options = {}) {
    this.command = codexCommand(options.command);
    this.cacheTtlMs = Number(options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
    this.cache = null;
    this.pending = null;
  }

  async read({ force = false } = {}) {
    if (!force && this.cache && Date.now() - this.cache.at < this.cacheTtlMs) return this.cache.value;
    if (this.pending) return this.pending;
    this.pending = this.request().then((value) => {
      this.cache = { at: Date.now(), value };
      return value;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  request() {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, ["app-server", "--listen", "stdio://"], {
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const lines = readline.createInterface({ input: child.stdout });
      let nextId = 1;
      let stderr = "";
      let settled = false;
      const pending = new Map();

      const stop = () => {
        lines.close();
        if (!child.killed) child.kill();
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        for (const entry of pending.values()) clearTimeout(entry.timer);
        pending.clear();
        stop();
        callback(value);
      };
      const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
      const request = (method, params = {}) => new Promise((resolveRequest, rejectRequest) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectRequest(quotaError(`Codex ${method} 超时`, stderr));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
        send({ method, id, params });
      });

      child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8000); });
      lines.on("line", (line) => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(quotaError(message.error.message || "Codex 请求失败", stderr));
        else entry.resolve(message.result);
      });
      child.on("error", (error) => finish(reject, quotaError("无法启动 Codex CLI", error.message)));
      child.on("exit", (code, signal) => {
        if (!settled) finish(reject, quotaError(`Codex App Server 意外退出（${signal || code}）`, stderr));
      });

      (async () => {
        try {
          await request("initialize", {
            clientInfo: { name: "codex_task_inventory", title: "Codex Task Inventory", version: "0.1.0" },
          });
          send({ method: "initialized", params: {} });
          const result = await request("account/rateLimits/read");
          finish(resolve, normalizeRateLimits(result));
        } catch (error) {
          finish(reject, error);
        }
      })();
    });
  }
}
