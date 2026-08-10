import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CodexMonitor } from "./codex-monitor.mjs";
import { buildTaskPrompt, CodexLauncher } from "./codex-launcher.mjs";
import { MacOSNotifier } from "./macos-notifier.mjs";
import { CodexQuotaReader } from "./codex-quota.mjs";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SERVER_DIR, "..");
const DEFAULT_DB = join(PROJECT_ROOT, "data", "monitor.db");
const DEFAULT_DIST = join(PROJECT_ROOT, "dist");
const LANES = ["inbox", "upcoming", "review", "completed"];
const PRIORITIES = ["low", "medium", "high"];
const MAX_BODY_BYTES = 256_000;
const MANAGER_PROMPT = [
  "$manage-codex-board",
  "读取当前 Codex 看板，先告诉我最需要关注的事项。除非我明确要求，否则不要创建或启动任务。",
].join("\n\n");

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return reject(new ApiError(413, "请求内容过大"));
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { reject(new ApiError(400, "请求必须是有效 JSON")); }
    });
    req.on("error", reject);
  });
}

export function initMetadata(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS thread_metadata (
      thread_id TEXT PRIMARY KEY,
      lane TEXT NOT NULL DEFAULT 'inbox' CHECK (lane IN ('inbox','upcoming','review','completed')),
      project_override TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      completed_at TEXT,
      last_seen_completion TEXT,
      last_seen_interruption TEXT,
      review_tracking_started_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS manual_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      lane TEXT NOT NULL DEFAULT 'inbox' CHECK (lane IN ('inbox','upcoming','review','completed')),
      project TEXT,
      cwd TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      codex_thread_id TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const manualColumns = new Set(db.prepare("PRAGMA table_info(manual_tasks)").all().map((column) => column.name));
  if (!manualColumns.has("cwd")) db.exec("ALTER TABLE manual_tasks ADD COLUMN cwd TEXT");
  if (!manualColumns.has("pinned")) db.exec("ALTER TABLE manual_tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  const metadataColumns = new Set(db.prepare("PRAGMA table_info(thread_metadata)").all().map((column) => column.name));
  if (!metadataColumns.has("pinned")) db.exec("ALTER TABLE thread_metadata ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  if (!metadataColumns.has("review_tracking_started_at")) {
    db.exec("ALTER TABLE thread_metadata ADD COLUMN review_tracking_started_at TEXT");
    db.exec("UPDATE thread_metadata SET review_tracking_started_at = updated_at WHERE review_tracking_started_at IS NULL");
  }
  if (!metadataColumns.has("last_seen_interruption")) db.exec("ALTER TABLE thread_metadata ADD COLUMN last_seen_interruption TEXT");
}

function metadataRepository(db) {
  const find = db.prepare("SELECT * FROM thread_metadata WHERE thread_id = ?");
  const discover = db.prepare(`INSERT OR IGNORE INTO thread_metadata
    (thread_id, lane, last_seen_completion, last_seen_interruption, review_tracking_started_at, updated_at) VALUES (?, 'inbox', ?, ?, ?, ?)`);
  const update = db.prepare(`UPDATE thread_metadata SET lane=?, project_override=?, tags=?, priority=?, sort_order=?, pinned=?, hidden=?, note=?, completed_at=?, last_seen_completion=?, last_seen_interruption=?, review_tracking_started_at=?, updated_at=? WHERE thread_id=?`);
  const acknowledgeExistingInterruption = db.prepare("UPDATE thread_metadata SET last_seen_interruption=? WHERE thread_id=? AND last_seen_interruption IS NULL");
  const launch = db.prepare(`INSERT OR REPLACE INTO thread_metadata
    (thread_id,lane,project_override,tags,priority,sort_order,pinned,hidden,note,completed_at,last_seen_completion,last_seen_interruption,review_tracking_started_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const map = (row) => {
    let tags = [];
    try { tags = JSON.parse(row.tags); } catch { /* ignore malformed local metadata */ }
    return { lane: row.lane, projectOverride: row.project_override, tags, priority: row.priority, sortOrder: row.sort_order, pinned: Boolean(row.pinned), hidden: Boolean(row.hidden), note: row.note, completedAt: row.completed_at, lastSeenCompletion: row.last_seen_completion, lastSeenInterruption: row.last_seen_interruption, reviewTrackingStartedAt: row.review_tracking_started_at, updatedAt: row.updated_at };
  };

  return {
    get(threadId) { const row = find.get(threadId); return row ? map(row) : null; },
    ensure(thread) {
      const now = new Date().toISOString();
      discover.run(thread.id, thread.lastCompletedAt, thread.lastInterruptedAt, now, now);
      let current = this.get(thread.id);
      if (current?.lane === "completed" && !current.lastSeenInterruption && thread.lastInterruptedAt && thread.lastInterruptedAt <= current.updatedAt) {
        acknowledgeExistingInterruption.run(thread.lastInterruptedAt, thread.id);
        current = this.get(thread.id);
      }
      return current;
    },
    patch(threadId, input, { lastCompletedAt = null, lastInterruptedAt = null } = {}) {
      const current = this.get(threadId);
      if (!current) throw new ApiError(404, "Codex 任务不存在或尚未同步");
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new ApiError(400, "请求内容必须是对象");
      const allowed = ["lane", "project", "tags", "priority", "sortOrder", "pinned", "hidden", "note"];
      const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
      if (unknown.length) throw new ApiError(400, `不支持字段：${unknown.join(", ")}`);
      const next = { ...current };
      if (input.lane !== undefined) {
        if (!LANES.includes(input.lane)) throw new ApiError(400, "无效的任务分组");
        next.lane = input.lane;
        next.completedAt = input.lane === "completed" ? (current.completedAt || new Date().toISOString()) : null;
        if (input.lane === "completed" && lastCompletedAt) next.lastSeenCompletion = lastCompletedAt;
        if (input.lane === "completed" && lastInterruptedAt) next.lastSeenInterruption = lastInterruptedAt;
      }
      if (input.project !== undefined) next.projectOverride = input.project ? String(input.project).trim().slice(0, 120) : null;
      if (input.tags !== undefined) {
        if (!Array.isArray(input.tags)) throw new ApiError(400, "tags 必须是数组");
        next.tags = [...new Set(input.tags.map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 20);
      }
      if (input.priority !== undefined) {
        if (!PRIORITIES.includes(input.priority)) throw new ApiError(400, "无效的优先级");
        next.priority = input.priority;
      }
      if (input.sortOrder !== undefined) next.sortOrder = Number.isSafeInteger(input.sortOrder) ? input.sortOrder : current.sortOrder;
      if (input.pinned !== undefined) next.pinned = Boolean(input.pinned);
      if (input.hidden !== undefined) next.hidden = Boolean(input.hidden);
      if (input.note !== undefined) next.note = String(input.note).slice(0, 4000);
      const now = new Date().toISOString();
      update.run(next.lane, next.projectOverride, JSON.stringify(next.tags), next.priority, next.sortOrder, next.pinned ? 1 : 0, next.hidden ? 1 : 0, next.note, next.completedAt, next.lastSeenCompletion, next.lastSeenInterruption, next.reviewTrackingStartedAt, now, threadId);
      return this.get(threadId);
    },
    createFromManual(threadId, task) {
      const now = new Date().toISOString();
      launch.run(threadId, "upcoming", task.project === "未归项目" ? null : task.project, JSON.stringify(task.tags), task.priority, task.sortOrder, task.pinned ? 1 : 0, 0, task.note, null, null, null, now, now);
      return this.get(threadId);
    },
    createManaged(threadId) {
      const now = new Date().toISOString();
      launch.run(threadId, "upcoming", null, "[]", "medium", 0, 0, 1, "", null, null, null, now, now);
      return this.get(threadId);
    },
  };
}

function manualRepository(db) {
  const find = db.prepare("SELECT * FROM manual_tasks WHERE id = ?");
  const insert = db.prepare(`INSERT INTO manual_tasks (id,title,note,lane,project,cwd,tags,priority,sort_order,pinned,codex_thread_id,completed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const update = db.prepare(`UPDATE manual_tasks SET title=?,note=?,lane=?,project=?,cwd=?,tags=?,priority=?,sort_order=?,pinned=?,codex_thread_id=?,completed_at=?,updated_at=? WHERE id=?`);
  const remove = db.prepare("DELETE FROM manual_tasks WHERE id = ?");
  const rows = db.prepare("SELECT * FROM manual_tasks WHERE codex_thread_id IS NULL ORDER BY lane, sort_order, updated_at DESC");
  const map = (row) => {
    let tags = [];
    try { tags = JSON.parse(row.tags); } catch { /* local data fallback */ }
    return {
      id: row.id, kind: "manual", title: row.title, preview: row.note, note: row.note, lane: row.lane,
      project: row.project || "未归项目", tags, priority: row.priority, sortOrder: row.sort_order,
      codexThreadId: row.codex_thread_id, deepLink: row.codex_thread_id ? `codex://threads/${row.codex_thread_id}` : null,
      runtimeStatus: "idle", cwd: row.cwd || "", source: "manual", archived: false, pinned: Boolean(row.pinned),
      createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at,
      activeTurnId: null, activeStartedAt: null, lastCompletedAt: null, lastProgress: "", lastProgressAt: null, lastFileChangeAt: null, lastError: "",
    };
  };
  const normalize = (input, current = {}) => {
    const next = { ...current };
    if (input.title !== undefined) next.title = String(input.title).trim().slice(0, 300);
    if (!next.title) throw new ApiError(400, "请填写待办名称");
    if (input.note !== undefined) next.note = String(input.note).slice(0, 4000);
    if (input.lane !== undefined) {
      if (!LANES.includes(input.lane)) throw new ApiError(400, "无效的任务分组");
      next.lane = input.lane;
    }
    if (input.project !== undefined) next.project = input.project ? String(input.project).trim().slice(0, 120) : null;
    if (input.cwd !== undefined) next.cwd = input.cwd ? String(input.cwd).trim().slice(0, 1000) : null;
    if (input.tags !== undefined) next.tags = [...new Set((Array.isArray(input.tags) ? input.tags : []).map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 20);
    if (input.priority !== undefined) {
      if (!PRIORITIES.includes(input.priority)) throw new ApiError(400, "无效的优先级");
      next.priority = input.priority;
    }
    if (input.sortOrder !== undefined && Number.isSafeInteger(input.sortOrder)) next.sortOrder = input.sortOrder;
    if (input.pinned !== undefined) next.pinned = Boolean(input.pinned);
    if (input.codexThreadId !== undefined) next.codexThreadId = input.codexThreadId ? String(input.codexThreadId).trim() : null;
    next.note ??= ""; next.lane ??= "inbox"; next.project ??= null; next.cwd ??= null; next.tags ??= []; next.priority ??= "medium"; next.sortOrder ??= 0; next.pinned ??= false; next.codexThreadId ??= null;
    return next;
  };
  const save = (id, next, createdAt) => {
    const now = new Date().toISOString();
    const completedAt = next.lane === "completed" ? (next.completedAt || now) : null;
    if (createdAt) insert.run(id,next.title,next.note,next.lane,next.project,next.cwd,JSON.stringify(next.tags),next.priority,next.sortOrder,next.pinned ? 1 : 0,next.codexThreadId,completedAt,createdAt,now);
    else update.run(next.title,next.note,next.lane,next.project,next.cwd,JSON.stringify(next.tags),next.priority,next.sortOrder,next.pinned ? 1 : 0,next.codexThreadId,completedAt,now,id);
    return map(find.get(id));
  };
  return {
    list() { return rows.all().map(map); },
    get(id) { const row = find.get(id); return row ? map(row) : null; },
    create(input) { const id = randomUUID(); const now = new Date().toISOString(); return save(id, normalize(input), now); },
    patch(id, input) { const row = find.get(id); if (!row) throw new ApiError(404, "待办不存在"); return save(id, normalize(input, map(row))); },
    delete(id) { if (!find.get(id)) throw new ApiError(404, "待办不存在"); remove.run(id); },
    batch(ids, input) { return ids.map((id) => this.patch(id, input)); },
  };
}

export function effectiveLane(thread, meta) {
  if (thread.runtimeStatus === "active") return "in_progress";
  if (thread.runtimeStatus === "waiting") return "in_progress";
  if (thread.archived) return "completed";
  const reviewBaseline = meta.lastSeenCompletion || meta.reviewTrackingStartedAt;
  if (thread.lastCompletedAt && (!reviewBaseline || thread.lastCompletedAt > reviewBaseline)) return "review";
  const interruptionBaseline = meta.lastSeenInterruption || meta.reviewTrackingStartedAt;
  if (thread.runtimeStatus === "interrupted" && thread.lastInterruptedAt && (!interruptionBaseline || thread.lastInterruptedAt > interruptionBaseline)) return "review";
  if (meta.lane === "completed") return "completed";
  return meta.lane;
}

function createSnapshot(monitor, metadata, threadNames = new Map(), { includeHidden = false } = {}) {
  return monitor.list().map((thread) => {
    const meta = metadata.ensure(thread);
    const syncedName = threadNames.get(thread.id);
    return { ...thread, ...(syncedName ? { title: syncedName } : {}), kind: "codex", ...meta, project: meta.projectOverride || thread.project, lane: effectiveLane(thread, meta) };
  }).filter((thread) => (includeHidden || !thread.hidden) && ["in_progress", "review", "completed"].includes(thread.lane));
}

function applyThreadNames(threads, threadNames) {
  return threads.map((thread) => {
    const syncedName = threadNames.get(thread.id);
    return syncedName ? { ...thread, title: syncedName } : thread;
  });
}

export function findReviewTransitions(previousThreads, nextThreads) {
  if (!previousThreads) return [];
  const previousLanes = new Map(previousThreads.map((thread) => [thread.id, thread.lane]));
  return nextThreads.filter((thread) => previousLanes.get(thread.id) === "in_progress" && thread.lane === "review");
}

const MIME_TYPES = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".woff": "font/woff", ".woff2": "font/woff2" };
function staticPath(distDir, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { throw new ApiError(400, "URL 无效"); }
  const candidate = resolve(distDir, `.${decoded}`);
  const rel = relative(distDir, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new ApiError(403, "禁止访问");
  return candidate;
}
function serveStatic(req, res, distDir, pathname) {
  if (!['GET', 'HEAD'].includes(req.method || '')) return false;
  let path = staticPath(distDir, pathname === "/" ? "/index.html" : pathname);
  if (!existsSync(path) || !statSync(path).isFile()) path = join(distDir, "index.html");
  if (!existsSync(path)) return false;
  const stat = statSync(path);
  res.writeHead(200, { "content-type": MIME_TYPES[extname(path)] || "application/octet-stream", "content-length": stat.size, "cache-control": path.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable" });
  req.method === "HEAD" ? res.end() : createReadStream(path).pipe(res);
  return true;
}

export function createTaskServer(options = {}) {
  const databasePath = resolve(options.databasePath || process.env.TASKBOARD_DB || DEFAULT_DB);
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  initMetadata(db);
  const metadata = metadataRepository(db);
  const manual = manualRepository(db);
  const monitor = options.monitor || new CodexMonitor(options.monitorOptions);
  const launcher = options.launcher || new CodexLauncher(options.launcherOptions);
  const quotaReader = options.quotaReader || new CodexQuotaReader(options.quotaOptions);
  const notifier = options.notifier || new MacOSNotifier(options.notificationOptions);
  const distDir = resolve(options.distDir || DEFAULT_DIST);
  const subscribers = new Set();
  let lastSignature = "";
  let previousThreads = null;
  let publishRunning = false;
  let publishPending = false;
  let threadNames = new Map();
  let namesRefreshedAt = 0;
  let namesRefreshPromise = null;
  const nameRefreshInterval = Math.max(0, Number(options.nameRefreshInterval ?? 5000));
  const refreshThreadNames = async ({ force = false, threadIds = [] } = {}) => {
    if (typeof launcher.listThreadNames !== "function") return threadNames;
    if (!force && Date.now() - namesRefreshedAt < nameRefreshInterval) return threadNames;
    if (namesRefreshPromise) return namesRefreshPromise;
    namesRefreshPromise = (async () => {
      try {
        const refreshed = await launcher.listThreadNames({ threadIds });
        threadNames = refreshed instanceof Map ? refreshed : new Map(Object.entries(refreshed || {}));
      } catch (error) {
        console.error("Codex thread name refresh failed", error);
      } finally {
        namesRefreshedAt = Date.now();
        namesRefreshPromise = null;
      }
      return threadNames;
    })();
    return namesRefreshPromise;
  };
  const publishOnce = async () => {
    try {
      const codexThreads = createSnapshot(monitor, metadata);
      await refreshThreadNames({ threadIds: codexThreads.map((thread) => thread.id) });
      const threads = [...manual.list(), ...applyThreadNames(codexThreads, threadNames)];
      const signature = JSON.stringify(threads.map((item) => [item.id, item.title, item.updatedAt, item.runtimeStatus, item.lastProgressAt, item.lane, item.pinned, item.hidden]));
      if (signature === lastSignature) return;
      const reviewTransitions = findReviewTransitions(previousThreads, threads);
      previousThreads = threads;
      lastSignature = signature;
      const payload = `event: threads-changed\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`;
      for (const subscriber of subscribers) subscriber.write(payload);
      for (const thread of reviewTransitions) {
        void notifier.notifyReview(thread).catch((error) => console.error("macOS review notification failed", error));
      }
    } catch (error) { console.error("Codex monitor refresh failed", error); }
  };
  const publishIfChanged = async () => {
    if (publishRunning) { publishPending = true; return; }
    publishRunning = true;
    try {
      do {
        publishPending = false;
        await publishOnce();
      } while (publishPending);
    } finally {
      publishRunning = false;
    }
  };
  const poller = setInterval(() => void publishIfChanged(), Number(options.pollInterval || 2000));
  poller.unref();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (url.pathname === "/api/health") return json(res, 200, { ok: true, source: "codex-local-state", tokenUsage: false });
      if (url.pathname === "/api/quota" && req.method === "GET") return json(res, 200, { quota: await quotaReader.read({ force: url.searchParams.get("refresh") === "1" }) });
      if (url.pathname === "/api/notifications/test" && req.method === "POST") {
        const result = await notifier.notify({ title: "Codex Task Monitor", subtitle: "macOS 通知测试", body: "通知已开启，任务进入待 Review 时会提醒你。" });
        if (!result.delivered) throw new ApiError(503, result.reason || "系统通知发送失败");
        return json(res, 200, result);
      }
      if (url.pathname === "/api/threads" && req.method === "GET") {
        const codexThreads = createSnapshot(monitor, metadata, new Map(), { includeHidden: url.searchParams.get("hidden") === "1" });
        await refreshThreadNames({ threadIds: codexThreads.map((thread) => thread.id) });
        return json(res, 200, { threads: [...manual.list(), ...applyThreadNames(codexThreads, threadNames)] });
      }
      if (url.pathname === "/api/manager/start" && req.method === "POST") {
        const launched = await launcher.launch({ cwd: PROJECT_ROOT, prompt: MANAGER_PROMPT });
        metadata.createManaged(launched.threadId);
        void publishIfChanged();
        return json(res, 200, launched);
      }
      if (url.pathname === "/api/items" && req.method === "POST") return json(res, 201, { item: manual.create(await parseBody(req)) });
      if (url.pathname === "/api/items/batch" && req.method === "POST") {
        const body = await parseBody(req);
        if (!Array.isArray(body.ids) || !body.ids.length) throw new ApiError(400, "请选择待 Review 任务");
        return json(res, 200, { items: manual.batch(body.ids, body.change || {}) });
      }
      const startMatch = url.pathname.match(/^\/api\/items\/([0-9a-f-]+)\/start$/i);
      if (startMatch && req.method === "POST") {
        const task = manual.get(startMatch[1]);
        if (!task) throw new ApiError(404, "待办不存在");
        if (task.lane !== "upcoming") throw new ApiError(409, "请先将事项移入待办列");
        if (!task.cwd) throw new ApiError(400, "请先填写工作目录");
        const cwd = resolve(task.cwd);
        if (!isAbsolute(task.cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) throw new ApiError(400, "工作目录必须是存在的绝对路径");
        const launched = await launcher.launch({ cwd, prompt: buildTaskPrompt(task) });
        metadata.createFromManual(launched.threadId, task);
        manual.patch(task.id, { codexThreadId: launched.threadId });
        publishIfChanged();
        return json(res, 200, launched);
      }
      const itemMatch = url.pathname.match(/^\/api\/items\/([0-9a-f-]+)$/i);
      if (itemMatch && req.method === "PATCH") return json(res, 200, { item: manual.patch(itemMatch[1], await parseBody(req)) });
      if (itemMatch && req.method === "DELETE") { manual.delete(itemMatch[1]); res.writeHead(204); return res.end(); }
      if (url.pathname === "/api/events" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
        res.write("retry: 3000\n\n");
        subscribers.add(res);
        req.on("close", () => subscribers.delete(res));
        return;
      }
      const match = url.pathname.match(/^\/api\/threads\/([0-9a-f-]+)$/i);
      if (match && req.method === "PATCH") {
        const thread = monitor.list().find((item) => item.id === match[1]);
        if (!thread) throw new ApiError(404, "Codex 任务不存在或尚未同步");
        const body = await parseBody(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "请求内容必须是对象");
        const currentMetadata = Object.keys(body).length
          ? metadata.patch(match[1], body, {
              lastCompletedAt: thread.lastCompletedAt || null,
              lastInterruptedAt: thread.lastInterruptedAt || null,
            })
          : metadata.get(match[1]);
        publishIfChanged();
        return json(res, 200, { metadata: currentMetadata });
      }
      if (url.pathname.startsWith("/api/")) throw new ApiError(404, "API 不存在");
      if (!serveStatic(req, res, distDir, url.pathname)) throw new ApiError(404, "文件不存在");
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      if (status === 500) console.error(error);
      if (!res.headersSent) json(res, status, { error: error instanceof ApiError ? error.message : "服务内部错误" });
    }
  });
  server.on("close", () => { clearInterval(poller); for (const item of subscribers) item.end(); launcher.close?.(); db.close(); });
  return server;
}

export function startTaskServer(options = {}) {
  const host = options.host || process.env.HOST || "127.0.0.1";
  const port = Number(options.port || process.env.PORT || 47824);
  const server = createTaskServer(options);
  server.listen(port, host, () => console.log(`Codex Task Monitor listening on http://${host}:${port}`));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) startTaskServer();
