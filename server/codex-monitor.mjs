import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAX_TEXT = 280;
const MAX_ROLLOUT_BYTES = 8 * 1024 * 1024;
const ACTIVE_FRESHNESS_MS = 15 * 60 * 1000;

function compact(value, max = MAX_TEXT) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function isoFromSeconds(value) {
  return new Date(Number(value) * 1000).toISOString();
}

export class CodexMonitor {
  constructor({ codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"), statePath } = {}) {
    this.codexHome = codexHome;
    this.statePath = statePath || join(codexHome, "state_5.sqlite");
    this.rolloutCache = new Map();
  }

  inspectRollout(path) {
    if (!path || !existsSync(path)) return { runtimeStatus: "unknown" };
    const stat = statSync(path);
    const cached = this.rolloutCache.get(path);
    if (cached?.size === stat.size && cached?.mtimeMs === stat.mtimeMs) return cached.value;

    let activeTurnId = null;
    let activeStartedAt = null;
    let lastCompletedAt = null;
    let lastProgress = "";
    let lastProgressAt = null;
    let lastFileChangeAt = null;
    let lastError = "";
    let lastAbortedAt = null;
    const pendingCalls = new Map();

    const bytes = Math.min(stat.size, MAX_ROLLOUT_BYTES);
    const buffer = Buffer.allocUnsafe(bytes);
    const fd = openSync(path, "r");
    try { readSync(fd, buffer, 0, bytes, stat.size - bytes); } finally { closeSync(fd); }
    let content = buffer.toString("utf8");
    if (stat.size > bytes) content = content.slice(content.indexOf("\n") + 1);
    for (const line of content.split("\n")) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const payload = entry.payload || {};
      const at = entry.timestamp || null;
      if (entry.type === "event_msg" && payload.type === "task_started") {
        activeTurnId = payload.turn_id || "unknown";
        activeStartedAt = at;
        lastError = "";
        pendingCalls.clear();
      } else if (entry.type === "event_msg" && payload.type === "task_complete") {
        activeTurnId = null;
        activeStartedAt = null;
        lastCompletedAt = at;
        if (payload.last_agent_message) lastProgress = compact(payload.last_agent_message);
        pendingCalls.clear();
      } else if (entry.type === "event_msg" && payload.type === "turn_aborted") {
        activeTurnId = null;
        activeStartedAt = null;
        lastAbortedAt = at;
        lastError = compact(payload.reason || "任务已中断");
        pendingCalls.clear();
      } else if (entry.type === "event_msg" && payload.type === "error") {
        lastError = compact(payload.message || payload.error || "执行失败");
      } else if (entry.type === "event_msg" && payload.type === "agent_message") {
        lastProgress = compact(payload.message || payload.text);
        lastProgressAt = at;
      } else if (entry.type === "event_msg" && payload.type === "patch_apply_end") {
        lastFileChangeAt = at;
      } else if (entry.type === "response_item" && ["function_call", "custom_tool_call"].includes(payload.type)) {
        const id = payload.call_id || payload.id;
        if (id) pendingCalls.set(id, payload.name || payload.tool_name || "tool");
      } else if (entry.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(payload.type)) {
        const id = payload.call_id || payload.id;
        if (id) pendingCalls.delete(id);
      }
    }

    const waitingOnUser = [...pendingCalls.values()].some((name) => /request_user_input|approval|elicitation/i.test(name));
    const activeIsFresh = Date.now() - stat.mtimeMs <= ACTIVE_FRESHNESS_MS;
    const runtimeStatus = lastError && lastAbortedAt && (!lastCompletedAt || lastAbortedAt > lastCompletedAt)
      ? "interrupted"
      : activeTurnId && !activeIsFresh ? "unknown"
      : activeTurnId ? (waitingOnUser ? "waiting" : "active") : "idle";
    const value = { runtimeStatus, activeTurnId, activeStartedAt, lastCompletedAt, lastInterruptedAt: lastAbortedAt, lastProgress, lastProgressAt, lastFileChangeAt, lastError, rolloutUpdatedAt: new Date(stat.mtimeMs).toISOString() };
    this.rolloutCache.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, value });
    return value;
  }

  list({ limit = 200, includeArchived = true } = {}) {
    if (!existsSync(this.statePath)) throw new Error(`找不到 Codex 状态库：${this.statePath}`);
    const db = new DatabaseSync(this.statePath, { readOnly: true });
    try {
      const rows = db.prepare(`
        SELECT id, name, title, preview, cwd, source, rollout_path, created_at, updated_at, archived, is_pinned
        FROM threads
        WHERE source IN ('vscode', 'cli') ${includeArchived ? "" : "AND archived = 0"}
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(Math.max(1, Math.min(Number(limit) || 200, 500)));
      return rows.map((row) => ({
        id: row.id,
        title: compact(row.name || row.title, 160) || "未命名 Codex 任务",
        preview: compact(row.preview),
        cwd: row.cwd,
        project: basename(row.cwd || "") || "未归项目",
        source: row.source,
        createdAt: isoFromSeconds(row.created_at),
        updatedAt: isoFromSeconds(row.updated_at),
        archived: Boolean(row.archived),
        pinned: Boolean(row.is_pinned),
        deepLink: `codex://threads/${row.id}`,
        ...this.inspectRollout(row.rollout_path),
      }));
    } finally {
      db.close();
    }
  }
}
