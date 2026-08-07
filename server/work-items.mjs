import { createHash, randomUUID } from "node:crypto";

export const WORK_STATUSES = ["inbox", "ready", "active", "awaiting_decision", "in_review", "blocked", "parked", "done", "canceled"];
export const WORK_STAGES = ["explore", "experiment", "execute", "verify"];
export const RUN_STATUSES = ["queued", "running", "waiting", "completed", "interrupted", "failed", "canceled"];
const PRIORITIES = ["low", "medium", "high"];

export class WorkItemError extends Error {
  constructor(status, message, code = "work_item_error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function now() {
  return new Date().toISOString();
}

function normalizedAttribution(input = {}) {
  const actorType = input.actorType === undefined || input.actorType === null || input.actorType === "" ? "user" : input.actorType;
  if (!["user", "codex", "system"].includes(actorType)) {
    throw new WorkItemError(400, "无效的 actor type", "invalid_actor_type");
  }
  const actorId = String(input.actorId || (actorType === "user" ? "local-user" : actorType)).trim().slice(0, 200);
  const threadId = input.threadId ? String(input.threadId).trim().slice(0, 200) : null;
  if (actorType === "codex" && !threadId) throw new WorkItemError(400, "Codex 写操作必须提供来源 thread ID", "missing_thread_id");
  return { actorType, actorId, threadId };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function requestHash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

let savepointSequence = 0;

function transaction(db, operation) {
  const savepoint = `work_items_${++savepointSequence}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = operation();
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}

export function initWorkItemSchema(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'inbox' CHECK (status IN ('inbox','ready','active','awaiting_decision','in_review','blocked','parked','done','canceled')),
      stage TEXT NOT NULL DEFAULT 'explore' CHECK (stage IN ('explore','experiment','execute','verify')),
      project TEXT,
      cwd TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      source_kind TEXT CHECK (source_kind IN ('manual','codex')),
      source_id TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source_kind, source_id)
    );
    CREATE TABLE IF NOT EXISTS work_item_runs (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_items(id),
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','waiting','completed','interrupted','failed','canceled')),
      objective TEXT NOT NULL DEFAULT '',
      codex_thread_id TEXT,
      codex_turn_id TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_item_runs_work_item ON work_item_runs(work_item_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_work_item_runs_thread ON work_item_runs(codex_thread_id);
    CREATE TABLE IF NOT EXISTS work_item_audit_events (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('work_item','run')),
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('user','codex','system')),
      actor_id TEXT NOT NULL,
      codex_thread_id TEXT,
      before_version INTEGER,
      after_version INTEGER,
      before_json TEXT,
      after_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_work_item_audit_entity ON work_item_audit_events(entity_type, entity_id, created_at);
    CREATE TABLE IF NOT EXISTS idempotency_records (
      operation TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(operation, idempotency_key)
    );
  `);
}

function mapWorkItem(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    stage: row.stage,
    project: row.project,
    cwd: row.cwd,
    tags: parseJson(row.tags, []),
    priority: row.priority,
    sortOrder: row.sort_order,
    pinned: Boolean(row.pinned),
    hidden: Boolean(row.hidden),
    source: row.source_kind && row.source_id ? { kind: row.source_kind, id: row.source_id } : null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRun(row) {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    status: row.status,
    objective: row.objective,
    codexThreadId: row.codex_thread_id,
    codexTurnId: row.codex_turn_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAudit(row) {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    action: row.action,
    actorType: row.actor_type,
    actorId: row.actor_id,
    codexThreadId: row.codex_thread_id,
    beforeVersion: row.before_version,
    afterVersion: row.after_version,
    before: row.before_json ? parseJson(row.before_json, null) : null,
    after: row.after_json ? parseJson(row.after_json, null) : null,
    createdAt: row.created_at,
  };
}

function normalizeWorkItem(input, current = {}) {
  const next = { ...current };
  if (input.title !== undefined) next.title = String(input.title).trim().slice(0, 300);
  if (!next.title) throw new WorkItemError(400, "请填写工作任务名称", "invalid_title");
  if (input.description !== undefined) next.description = String(input.description).slice(0, 10_000);
  if (input.status !== undefined) {
    if (!WORK_STATUSES.includes(input.status)) throw new WorkItemError(400, "无效的工作状态", "invalid_status");
    next.status = input.status;
  }
  if (input.stage !== undefined) {
    if (!WORK_STAGES.includes(input.stage)) throw new WorkItemError(400, "无效的工作阶段", "invalid_stage");
    next.stage = input.stage;
  }
  if (input.project !== undefined) next.project = input.project ? String(input.project).trim().slice(0, 120) : null;
  if (input.cwd !== undefined) next.cwd = input.cwd ? String(input.cwd).trim().slice(0, 1000) : null;
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags)) throw new WorkItemError(400, "tags 必须是数组", "invalid_tags");
    next.tags = [...new Set(input.tags.map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 20);
  }
  if (input.priority !== undefined) {
    if (!PRIORITIES.includes(input.priority)) throw new WorkItemError(400, "无效的优先级", "invalid_priority");
    next.priority = input.priority;
  }
  if (input.sortOrder !== undefined) next.sortOrder = Number.isSafeInteger(input.sortOrder) ? input.sortOrder : (next.sortOrder || 0);
  if (input.pinned !== undefined) next.pinned = Boolean(input.pinned);
  if (input.hidden !== undefined) next.hidden = Boolean(input.hidden);
  if (input.sourceKind !== undefined) {
    if (input.sourceKind !== null && !["manual", "codex"].includes(input.sourceKind)) throw new WorkItemError(400, "无效的来源类型", "invalid_source_kind");
    next.sourceKind = input.sourceKind;
  }
  if (input.sourceId !== undefined) next.sourceId = input.sourceId ? String(input.sourceId).trim().slice(0, 200) : null;
  next.description ??= "";
  next.status ??= "inbox";
  next.stage ??= "explore";
  next.project ??= null;
  next.cwd ??= null;
  next.tags ??= [];
  next.priority ??= "medium";
  next.sortOrder ??= 0;
  next.pinned ??= false;
  next.hidden ??= false;
  next.sourceKind ??= null;
  next.sourceId ??= null;
  return next;
}

function normalizeRun(input, current = {}) {
  const next = { ...current };
  if (input.status !== undefined) {
    if (!RUN_STATUSES.includes(input.status)) throw new WorkItemError(400, "无效的运行状态", "invalid_run_status");
    next.status = input.status;
  }
  if (input.objective !== undefined) next.objective = String(input.objective).slice(0, 10_000);
  if (input.codexThreadId !== undefined) next.codexThreadId = input.codexThreadId ? String(input.codexThreadId).trim().slice(0, 200) : null;
  if (input.codexTurnId !== undefined) next.codexTurnId = input.codexTurnId ? String(input.codexTurnId).trim().slice(0, 200) : null;
  next.status ??= "queued";
  next.objective ??= "";
  next.codexThreadId ??= null;
  next.codexTurnId ??= null;
  return next;
}

function assertExpectedVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new WorkItemError(400, "必须提供有效的 expectedVersion", "invalid_expected_version");
}

function assertCodexCannotComplete(attribution, status) {
  if (attribution.actorType === "codex" && status === "done") throw new WorkItemError(403, "Codex 不能自行确认工作任务完成", "codex_cannot_complete");
}

export function createWorkItemRepository(db) {
  const findWorkItem = db.prepare("SELECT * FROM work_items WHERE id=?");
  const findWorkItemBySource = db.prepare("SELECT * FROM work_items WHERE source_kind=? AND source_id=?");
  const listWorkItems = db.prepare("SELECT * FROM work_items ORDER BY updated_at DESC, id");
  const insertWorkItem = db.prepare(`INSERT INTO work_items
    (id,title,description,status,stage,project,cwd,tags,priority,sort_order,pinned,hidden,source_kind,source_id,version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const updateWorkItem = db.prepare(`UPDATE work_items SET
    title=?,description=?,status=?,stage=?,project=?,cwd=?,tags=?,priority=?,sort_order=?,pinned=?,hidden=?,version=?,updated_at=?
    WHERE id=? AND version=?`);
  const findRun = db.prepare("SELECT * FROM work_item_runs WHERE id=?");
  const findRunByThread = db.prepare("SELECT * FROM work_item_runs WHERE codex_thread_id=? ORDER BY created_at LIMIT 1");
  const listRuns = db.prepare("SELECT * FROM work_item_runs WHERE work_item_id=? ORDER BY rowid");
  const insertRun = db.prepare(`INSERT INTO work_item_runs
    (id,work_item_id,status,objective,codex_thread_id,codex_turn_id,version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const updateRun = db.prepare(`UPDATE work_item_runs SET status=?,objective=?,codex_thread_id=?,codex_turn_id=?,version=?,updated_at=?
    WHERE id=? AND version=?`);
  const insertAudit = db.prepare(`INSERT INTO work_item_audit_events
    (id,entity_type,entity_id,action,actor_type,actor_id,codex_thread_id,before_version,after_version,before_json,after_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const listAudit = db.prepare("SELECT * FROM work_item_audit_events WHERE entity_type=? AND entity_id=? ORDER BY rowid");
  const findIdempotency = db.prepare("SELECT * FROM idempotency_records WHERE operation=? AND idempotency_key=?");
  const insertIdempotency = db.prepare("INSERT INTO idempotency_records (operation,idempotency_key,request_hash,response_json,created_at) VALUES (?,?,?,?,?)");

  function audit(entityType, entityId, action, attributionInput, before, after) {
    const attribution = normalizedAttribution(attributionInput);
    insertAudit.run(
      randomUUID(), entityType, entityId, action, attribution.actorType, attribution.actorId, attribution.threadId,
      before?.version ?? null, after?.version ?? null,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, now(),
    );
  }

  function idempotent(operation, key, request, perform) {
    if (!key || !String(key).trim()) throw new WorkItemError(400, "必须提供 idempotencyKey", "missing_idempotency_key");
    const normalizedKey = String(key).trim().slice(0, 200);
    const hash = requestHash(request);
    return transaction(db, () => {
      const existing = findIdempotency.get(operation, normalizedKey);
      if (existing) {
        if (existing.request_hash !== hash) throw new WorkItemError(409, "相同幂等键对应了不同请求", "idempotency_conflict");
        return parseJson(existing.response_json, null);
      }
      const response = perform();
      insertIdempotency.run(operation, normalizedKey, hash, JSON.stringify(response), now());
      return response;
    });
  }

  function create(input, attributionInput = {}, options = {}) {
    const attribution = normalizedAttribution(attributionInput);
    const normalized = normalizeWorkItem(input);
    assertCodexCannotComplete(attribution, normalized.status);
    const perform = () => {
      const createdAt = now();
      const id = options.id || randomUUID();
      insertWorkItem.run(
        id, normalized.title, normalized.description, normalized.status, normalized.stage, normalized.project, normalized.cwd,
        JSON.stringify(normalized.tags), normalized.priority, normalized.sortOrder, normalized.pinned ? 1 : 0, normalized.hidden ? 1 : 0,
        normalized.sourceKind, normalized.sourceId, 1, createdAt, createdAt,
      );
      const created = mapWorkItem(findWorkItem.get(id));
      audit("work_item", id, options.action || "create", attribution, null, created);
      return created;
    };
    if (options.idempotencyKey) return idempotent("work_item.create", options.idempotencyKey, normalized, perform);
    return transaction(db, perform);
  }

  function update(id, expectedVersion, change, attributionInput = {}) {
    assertExpectedVersion(expectedVersion);
    const attribution = normalizedAttribution(attributionInput);
    return transaction(db, () => {
      const row = findWorkItem.get(id);
      if (!row) throw new WorkItemError(404, "工作任务不存在", "work_item_not_found");
      const current = mapWorkItem(row);
      if (current.version !== expectedVersion) throw new WorkItemError(409, "工作任务已被其他操作修改，请重新读取", "version_conflict");
      const next = normalizeWorkItem(change, { ...current, sourceKind: current.source?.kind || null, sourceId: current.source?.id || null });
      assertCodexCannotComplete(attribution, next.status);
      const nextVersion = current.version + 1;
      const result = updateWorkItem.run(
        next.title, next.description, next.status, next.stage, next.project, next.cwd, JSON.stringify(next.tags), next.priority,
        next.sortOrder, next.pinned ? 1 : 0, next.hidden ? 1 : 0, nextVersion, now(), id, expectedVersion,
      );
      if (Number(result.changes) !== 1) throw new WorkItemError(409, "工作任务已被其他操作修改，请重新读取", "version_conflict");
      const updated = mapWorkItem(findWorkItem.get(id));
      audit("work_item", id, "update", attribution, current, updated);
      return updated;
    });
  }

  function createRun(workItemId, input, attributionInput = {}, idempotencyKey) {
    const attribution = normalizedAttribution(attributionInput);
    const normalized = normalizeRun(input);
    return idempotent(`run.create:${workItemId}`, idempotencyKey, normalized, () => {
      if (!findWorkItem.get(workItemId)) throw new WorkItemError(404, "工作任务不存在", "work_item_not_found");
      const id = randomUUID();
      const createdAt = now();
      insertRun.run(id, workItemId, normalized.status, normalized.objective, normalized.codexThreadId, normalized.codexTurnId, 1, createdAt, createdAt);
      const created = mapRun(findRun.get(id));
      audit("run", id, "create", attribution, null, created);
      return created;
    });
  }

  function updateExistingRun(id, expectedVersion, change, attributionInput = {}) {
    assertExpectedVersion(expectedVersion);
    const attribution = normalizedAttribution(attributionInput);
    return transaction(db, () => {
      const row = findRun.get(id);
      if (!row) throw new WorkItemError(404, "运行记录不存在", "run_not_found");
      const current = mapRun(row);
      if (current.version !== expectedVersion) throw new WorkItemError(409, "运行记录已被其他操作修改，请重新读取", "version_conflict");
      const next = normalizeRun(change, current);
      const nextVersion = current.version + 1;
      const result = updateRun.run(next.status, next.objective, next.codexThreadId, next.codexTurnId, nextVersion, now(), id, expectedVersion);
      if (Number(result.changes) !== 1) throw new WorkItemError(409, "运行记录已被其他操作修改，请重新读取", "version_conflict");
      const updated = mapRun(findRun.get(id));
      audit("run", id, "update", attribution, current, updated);
      return updated;
    });
  }

  return {
    list() { return listWorkItems.all().map(mapWorkItem); },
    get(id) { const row = findWorkItem.get(id); return row ? mapWorkItem(row) : null; },
    getBySource(kind, id) { const row = findWorkItemBySource.get(kind, id); return row ? mapWorkItem(row) : null; },
    create,
    update,
    listRuns(workItemId) {
      if (!findWorkItem.get(workItemId)) throw new WorkItemError(404, "工作任务不存在", "work_item_not_found");
      return listRuns.all(workItemId).map(mapRun);
    },
    getRun(id) { const row = findRun.get(id); return row ? mapRun(row) : null; },
    getRunByThread(threadId) { const row = findRunByThread.get(threadId); return row ? mapRun(row) : null; },
    createRun,
    updateRun: updateExistingRun,
    listAudit(entityType, entityId) { return listAudit.all(entityType, entityId).map(mapAudit); },
    importWorkItem(input, source, attribution = { actorType: "system", actorId: "legacy-migration" }) {
      const existing = this.getBySource(source.kind, source.id);
      if (existing) return existing;
      return create({ ...input, sourceKind: source.kind, sourceId: source.id }, attribution, { action: "legacy_import" });
    },
    importRun(workItemId, input, sourceKey, attribution = { actorType: "system", actorId: "legacy-migration" }) {
      if (input.codexThreadId) {
        const existing = this.getRunByThread(input.codexThreadId);
        if (existing) return existing;
      }
      return createRun(workItemId, input, attribution, `legacy:${sourceKey}`);
    },
  };
}

function laneToWorkStatus(lane) {
  return ({ inbox: "inbox", upcoming: "ready", review: "in_review", completed: "done" })[lane] || "inbox";
}

function runtimeToRunStatus(runtimeStatus) {
  return ({ active: "running", waiting: "waiting", interrupted: "interrupted", idle: "completed" })[runtimeStatus] || "queued";
}

function monitoredToWorkStatus(thread) {
  if (thread.archived) return "done";
  if (["active", "waiting"].includes(thread.runtimeStatus)) return "active";
  if (thread.runtimeStatus === "interrupted" || thread.lastCompletedAt) return "in_review";
  return "inbox";
}

export function migrateLegacyWork(db, repository, monitoredThreads = []) {
  const threadById = new Map(monitoredThreads.map((thread) => [thread.id, thread]));
  const manualRows = db.prepare("SELECT * FROM manual_tasks ORDER BY created_at, id").all();
  const metadataRows = db.prepare("SELECT * FROM thread_metadata ORDER BY updated_at, thread_id").all();

  return transaction(db, () => {
    for (const row of manualRows) {
      const workItem = repository.importWorkItem({
        title: row.title,
        description: row.note,
        status: laneToWorkStatus(row.lane),
        stage: row.lane === "inbox" ? "explore" : "execute",
        project: row.project,
        cwd: row.cwd,
        tags: parseJson(row.tags, []),
        priority: row.priority,
        sortOrder: row.sort_order,
        pinned: Boolean(row.pinned),
      }, { kind: "manual", id: row.id });
      if (!row.codex_thread_id) continue;
      const monitored = threadById.get(row.codex_thread_id);
      repository.importRun(workItem.id, {
        status: runtimeToRunStatus(monitored?.runtimeStatus),
        objective: row.note || row.title,
        codexThreadId: row.codex_thread_id,
        codexTurnId: monitored?.activeTurnId || null,
      }, `manual:${row.id}:${row.codex_thread_id}`);
    }

    for (const row of metadataRows) {
      if (repository.getRunByThread(row.thread_id)) continue;
      const monitored = threadById.get(row.thread_id);
      const workItem = repository.importWorkItem({
        title: monitored?.title || `Codex 任务 ${row.thread_id.slice(0, 8)}`,
        description: row.note,
        status: laneToWorkStatus(row.lane),
        stage: "execute",
        project: row.project_override || monitored?.project || null,
        cwd: monitored?.cwd || null,
        tags: parseJson(row.tags, []),
        priority: row.priority,
        sortOrder: row.sort_order,
        pinned: Boolean(row.pinned),
        hidden: Boolean(row.hidden),
      }, { kind: "codex", id: row.thread_id });
      repository.importRun(workItem.id, {
        status: runtimeToRunStatus(monitored?.runtimeStatus),
        objective: row.note || monitored?.preview || monitored?.title || "",
        codexThreadId: row.thread_id,
        codexTurnId: monitored?.activeTurnId || null,
      }, `codex:${row.thread_id}`);
    }

    for (const monitored of monitoredThreads) {
      if (repository.getRunByThread(monitored.id)) continue;
      const workItem = repository.importWorkItem({
        title: monitored.title || `Codex 任务 ${monitored.id.slice(0, 8)}`,
        description: monitored.preview || "",
        status: monitoredToWorkStatus(monitored),
        stage: "execute",
        project: monitored.project || null,
        cwd: monitored.cwd || null,
        tags: [],
        priority: "medium",
      }, { kind: "codex", id: monitored.id });
      repository.importRun(workItem.id, {
        status: runtimeToRunStatus(monitored.runtimeStatus),
        objective: monitored.preview || monitored.title || "",
        codexThreadId: monitored.id,
        codexTurnId: monitored.activeTurnId || null,
      }, `codex-monitor:${monitored.id}`);
    }
  });
}
