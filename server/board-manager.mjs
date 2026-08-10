import { createHash, randomUUID } from "node:crypto";
import { WorkItemError } from "./work-items.mjs";

const CALL_ACTION = "inbox_organize";
const SUGGESTION_KINDS = ["update_work_item", "duplicate_candidate"];
const ALLOWED_PATCH_FIELDS = ["title", "description", "goal", "nextAction", "project", "tags", "status", "stage"];
const STAGES = ["explore", "experiment", "execute", "verify"];
let savepointSequence = 0;

function now() { return new Date().toISOString(); }
function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function requestHash(value) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }

function transaction(db, operation) {
  const savepoint = `board_manager_${++savepointSequence}`;
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

function attribution(input = {}) {
  const actorType = input.actorType || "user";
  if (!["user", "codex", "system"].includes(actorType)) throw new WorkItemError(400, "无效的 actor type", "invalid_actor_type");
  const actorId = String(input.actorId || (actorType === "user" ? "local-user" : actorType)).trim().slice(0, 200);
  const threadId = input.threadId ? String(input.threadId).trim().slice(0, 200) : null;
  if (actorType === "codex" && !threadId) throw new WorkItemError(400, "Codex 写操作必须提供来源 thread ID", "missing_thread_id");
  return { actorType, actorId, threadId };
}

function mapCall(row) {
  return {
    id: row.id,
    action: row.action,
    status: row.status,
    input: parseJson(row.input_json, { action: CALL_ACTION, inboxItems: [] }),
    inputItemCount: row.input_item_count,
    summary: row.summary,
    codexThreadId: row.codex_thread_id,
    codexTurnId: row.codex_turn_id,
    sourceUri: row.codex_thread_id ? `codex://threads/${row.codex_thread_id}${row.codex_turn_id ? `?turn=${row.codex_turn_id}` : ""}` : null,
    error: row.error,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSuggestion(row) {
  return {
    id: row.id,
    callId: row.call_id,
    kind: row.kind,
    workItemId: row.work_item_id,
    relatedWorkItemId: row.related_work_item_id,
    expectedWorkItemVersion: row.expected_work_item_version,
    title: row.title,
    reason: row.reason,
    impact: row.impact,
    patch: parseJson(row.patch_json, {}),
    state: row.state,
    appliedAt: row.applied_at,
    createdAt: row.created_at,
  };
}

function mapAudit(row) {
  return {
    id: row.id,
    callId: row.call_id,
    action: row.action,
    actorType: row.actor_type,
    actorId: row.actor_id,
    codexThreadId: row.codex_thread_id,
    details: parseJson(row.details_json, {}),
    createdAt: row.created_at,
  };
}

export function initBoardManagerSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS board_manager_calls (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL CHECK (action IN ('inbox_organize')),
      status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','uncertain')),
      input_json TEXT NOT NULL,
      input_item_count INTEGER NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      codex_thread_id TEXT,
      codex_turn_id TEXT,
      error TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS board_manager_suggestions (
      id TEXT PRIMARY KEY,
      call_id TEXT NOT NULL REFERENCES board_manager_calls(id),
      kind TEXT NOT NULL CHECK (kind IN ('update_work_item','duplicate_candidate')),
      work_item_id TEXT NOT NULL REFERENCES work_items(id),
      related_work_item_id TEXT REFERENCES work_items(id),
      expected_work_item_version INTEGER NOT NULL,
      title TEXT NOT NULL,
      reason TEXT NOT NULL,
      impact TEXT NOT NULL,
      patch_json TEXT NOT NULL DEFAULT '{}',
      state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','applied')),
      applied_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_board_manager_suggestions_call ON board_manager_suggestions(call_id, created_at);
    CREATE TABLE IF NOT EXISTS board_manager_idempotency (
      operation TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(operation,idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS board_manager_audit_events (
      id TEXT PRIMARY KEY,
      call_id TEXT NOT NULL REFERENCES board_manager_calls(id),
      action TEXT NOT NULL,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('user','codex','system')),
      actor_id TEXT NOT NULL,
      codex_thread_id TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `);
}

function minimalInboxInput(workItems) {
  return {
    action: CALL_ACTION,
    generatedAt: now(),
    inboxItems: workItems.list().filter((item) => item.status === "inbox" && !item.hidden).map((item) => ({
      id: item.id,
      version: item.version,
      title: item.title,
      summary: item.description.slice(0, 800),
      goal: item.goal.slice(0, 800),
      nextAction: item.nextAction.slice(0, 500),
      project: item.project,
      tags: item.tags,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    })),
  };
}

export function buildInboxOrganizerPrompt(input) {
  return `你是 Codex Workbench 的看板管家。本次只整理收集箱，不执行任何具体任务，不读文件，不启动 Run，不改变业务优先级，也不把任务标记为完成。

请根据下方最小任务摘要，返回一个 JSON 对象，不要输出 Markdown 或额外说明：
{
  "summary": "一句话概括本次整理",
  "suggestions": [
    {
      "kind": "update_work_item",
      "workItemId": "原任务 ID",
      "title": "建议标题",
      "reason": "为什么建议这样整理",
      "impact": "用户确认后会发生什么",
      "patch": {
        "title": "可选",
        "description": "可选",
        "goal": "可选；信息不足时不要编造",
        "nextAction": "可选；必须是一个具体动作",
        "project": "可选或 null",
        "tags": ["可选"],
        "stage": "explore|experiment|execute|verify，可选",
        "status": "只能是 inbox 或 ready；仅在目标、下一步和基本边界已足够明确时建议 ready"
      }
    },
    {
      "kind": "duplicate_candidate",
      "workItemId": "任务 ID",
      "relatedWorkItemId": "疑似重复任务 ID",
      "title": "疑似重复",
      "reason": "重复依据",
      "impact": "仅提示，当前不会自动合并"
    }
  ]
}

规则：
- 只能引用输入中存在的 Work Item ID。
- 不得建议 done、active、todayFocus、priority、Run 或生产操作。
- 不确定的信息保持原样；可以不给某个任务建议。
- duplicate_candidate 只做提示，不生成合并写操作。

输入：
${JSON.stringify(input)}`;
}

function extractJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new WorkItemError(422, "看板管家没有返回结构化结果", "empty_manager_result");
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(unfenced); } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(unfenced.slice(start, end + 1)); } catch { /* use structured error below */ }
    }
  }
  throw new WorkItemError(422, "看板管家返回的结果不是有效 JSON", "invalid_manager_result");
}

function normalizedPatch(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new WorkItemError(422, "管家建议 patch 必须是对象", "invalid_manager_suggestion");
  const unknown = Object.keys(input).filter((key) => !ALLOWED_PATCH_FIELDS.includes(key));
  if (unknown.length) throw new WorkItemError(422, `管家建议包含越权字段：${unknown.join(", ")}`, "manager_suggestion_out_of_scope");
  const patch = {};
  if (input.title !== undefined) patch.title = String(input.title).trim().slice(0, 300);
  if (input.description !== undefined) patch.description = String(input.description).slice(0, 10_000);
  if (input.goal !== undefined) patch.goal = String(input.goal).slice(0, 10_000);
  if (input.nextAction !== undefined) patch.nextAction = String(input.nextAction).slice(0, 2_000);
  if (input.project !== undefined) patch.project = input.project ? String(input.project).trim().slice(0, 120) : null;
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags)) throw new WorkItemError(422, "管家建议 tags 必须是数组", "invalid_manager_suggestion");
    patch.tags = [...new Set(input.tags.map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 20);
  }
  if (input.status !== undefined) {
    if (!["inbox", "ready"].includes(input.status)) throw new WorkItemError(422, "管家只能建议 inbox 或 ready", "manager_suggestion_out_of_scope");
    patch.status = input.status;
  }
  if (input.stage !== undefined) {
    if (!STAGES.includes(input.stage)) throw new WorkItemError(422, "管家建议的阶段无效", "invalid_manager_suggestion");
    patch.stage = input.stage;
  }
  if (!Object.keys(patch).length) throw new WorkItemError(422, "管家更新建议不能为空", "invalid_manager_suggestion");
  return patch;
}

function normalizedResult(finalMessage, input) {
  const result = extractJson(finalMessage);
  if (!result || typeof result !== "object" || Array.isArray(result) || !Array.isArray(result.suggestions)) {
    throw new WorkItemError(422, "看板管家结果缺少 suggestions 数组", "invalid_manager_result");
  }
  const items = new Map(input.inboxItems.map((item) => [item.id, item]));
  const suggestions = result.suggestions.slice(0, 100).map((suggestion) => {
    if (!suggestion || typeof suggestion !== "object" || !SUGGESTION_KINDS.includes(suggestion.kind)) throw new WorkItemError(422, "看板管家建议类型无效", "invalid_manager_suggestion");
    const item = items.get(String(suggestion.workItemId || ""));
    if (!item) throw new WorkItemError(422, "看板管家引用了输入外的任务", "manager_suggestion_out_of_scope");
    const relatedWorkItemId = suggestion.relatedWorkItemId ? String(suggestion.relatedWorkItemId) : null;
    if (suggestion.kind === "duplicate_candidate" && (!relatedWorkItemId || !items.has(relatedWorkItemId) || relatedWorkItemId === item.id)) {
      throw new WorkItemError(422, "疑似重复建议必须引用另一个输入任务", "invalid_manager_suggestion");
    }
    return {
      id: randomUUID(),
      kind: suggestion.kind,
      workItemId: item.id,
      relatedWorkItemId: suggestion.kind === "duplicate_candidate" ? relatedWorkItemId : null,
      expectedWorkItemVersion: item.version,
      title: String(suggestion.title || (suggestion.kind === "duplicate_candidate" ? "疑似重复" : "整理任务信息")).trim().slice(0, 300),
      reason: String(suggestion.reason || "").trim().slice(0, 2_000),
      impact: String(suggestion.impact || "").trim().slice(0, 2_000),
      patch: suggestion.kind === "update_work_item" ? normalizedPatch(suggestion.patch) : {},
    };
  });
  const updateIds = suggestions.filter((suggestion) => suggestion.kind === "update_work_item").map((suggestion) => suggestion.workItemId);
  if (new Set(updateIds).size !== updateIds.length) throw new WorkItemError(422, "同一任务只能生成一条更新建议", "invalid_manager_suggestion");
  return { summary: String(result.summary || "收集箱整理建议已生成").trim().slice(0, 2_000), suggestions };
}

export function createBoardManagerService({ db, workItems, launcher, cwd, onManagerThread }) {
  const findCall = db.prepare("SELECT * FROM board_manager_calls WHERE id=?");
  const latestCall = db.prepare("SELECT * FROM board_manager_calls WHERE action=? ORDER BY rowid DESC LIMIT 1");
  const insertCall = db.prepare(`INSERT INTO board_manager_calls
    (id,action,status,input_json,input_item_count,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`);
  const updateCallLocation = db.prepare(`UPDATE board_manager_calls SET status=?,codex_thread_id=?,codex_turn_id=?,version=version+1,updated_at=? WHERE id=? AND version=?`);
  const completeCall = db.prepare(`UPDATE board_manager_calls SET status=?,summary=?,error=?,version=version+1,updated_at=? WHERE id=? AND version=?`);
  const insertSuggestion = db.prepare(`INSERT INTO board_manager_suggestions
    (id,call_id,kind,work_item_id,related_work_item_id,expected_work_item_version,title,reason,impact,patch_json,state,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?)`);
  const listSuggestions = db.prepare("SELECT * FROM board_manager_suggestions WHERE call_id=? ORDER BY rowid");
  const findSuggestion = db.prepare("SELECT * FROM board_manager_suggestions WHERE id=? AND call_id=?");
  const markSuggestionApplied = db.prepare("UPDATE board_manager_suggestions SET state='applied',applied_at=? WHERE id=? AND state='pending'");
  const findIdempotency = db.prepare("SELECT * FROM board_manager_idempotency WHERE operation=? AND idempotency_key=?");
  const insertIdempotency = db.prepare("INSERT INTO board_manager_idempotency VALUES (?,?,?,?,?)");
  const insertAudit = db.prepare("INSERT INTO board_manager_audit_events VALUES (?,?,?,?,?,?,?,?)");
  const listAudit = db.prepare("SELECT * FROM board_manager_audit_events WHERE call_id=? ORDER BY rowid");

  function audit(callId, action, actorInput, details = {}) {
    const item = attribution(actorInput);
    insertAudit.run(randomUUID(), callId, action, item.actorType, item.actorId, item.threadId, JSON.stringify(details), now());
  }

  function get(id) {
    const row = findCall.get(id);
    if (!row) throw new WorkItemError(404, "看板管家调用不存在", "manager_call_not_found");
    return { call: mapCall(row), suggestions: listSuggestions.all(id).map(mapSuggestion) };
  }

  function updateLocation(id, change) {
    return transaction(db, () => {
      const row = findCall.get(id);
      const version = row.version;
      const result = updateCallLocation.run(change.status || row.status, change.threadId ?? row.codex_thread_id, change.turnId ?? row.codex_turn_id, now(), id, version);
      if (Number(result.changes) !== 1) throw new WorkItemError(409, "看板管家调用状态冲突", "manager_call_conflict");
      return mapCall(findCall.get(id));
    });
  }

  function finish(id, event) {
    return transaction(db, () => {
      const row = findCall.get(id);
      if (!row || ["completed", "failed", "uncertain"].includes(row.status)) return row ? get(id) : null;
      let status = "failed";
      let summary = "";
      let error = event.error || "看板管家执行失败";
      let result = null;
      if (event.status === "completed") {
        try {
          result = normalizedResult(event.finalMessage, parseJson(row.input_json, { inboxItems: [] }));
          status = "completed";
          summary = result.summary;
          error = null;
        } catch (reason) {
          error = reason instanceof Error ? reason.message : String(reason);
        }
      }
      const updated = completeCall.run(status, summary, error, now(), id, row.version);
      if (Number(updated.changes) !== 1) throw new WorkItemError(409, "看板管家调用状态冲突", "manager_call_conflict");
      if (result) {
        const createdAt = now();
        for (const suggestion of result.suggestions) {
          insertSuggestion.run(suggestion.id, id, suggestion.kind, suggestion.workItemId, suggestion.relatedWorkItemId,
            suggestion.expectedWorkItemVersion, suggestion.title, suggestion.reason, suggestion.impact, JSON.stringify(suggestion.patch), createdAt);
        }
      }
      audit(id, status === "completed" ? "suggestions_generated" : "generation_failed", { actorType: "codex", actorId: "board-manager", threadId: row.codex_thread_id || event.threadId }, { suggestionCount: result?.suggestions.length || 0, error });
      return get(id);
    });
  }

  async function organizeInbox(input = {}, actorInput = {}) {
    const actor = attribution(actorInput);
    if (actor.actorType !== "user") throw new WorkItemError(403, "只有用户可以调用看板管家", "user_confirmation_required");
    if (!input.idempotencyKey || !String(input.idempotencyKey).trim()) throw new WorkItemError(400, "必须提供 idempotencyKey", "missing_idempotency_key");
    const key = String(input.idempotencyKey).trim().slice(0, 200);
    const operation = "board_manager.inbox_organize";
    const hash = requestHash({ action: CALL_ACTION });
    let callId;
    let replayed = false;
    transaction(db, () => {
      const existing = findIdempotency.get(operation, key);
      if (existing) {
        if (existing.request_hash !== hash) throw new WorkItemError(409, "相同幂等键对应了不同请求", "idempotency_conflict");
        callId = parseJson(existing.response_json, {}).callId;
        replayed = true;
        return;
      }
      const snapshot = minimalInboxInput(workItems);
      callId = randomUUID();
      const createdAt = now();
      insertCall.run(callId, CALL_ACTION, snapshot.inboxItems.length ? "queued" : "completed", JSON.stringify(snapshot), snapshot.inboxItems.length,
        1, createdAt, createdAt);
      insertIdempotency.run(operation, key, hash, JSON.stringify({ callId }), createdAt);
      audit(callId, "requested", actor, { inputItemCount: snapshot.inboxItems.length });
      if (!snapshot.inboxItems.length) {
        completeCall.run("completed", "收集箱当前没有需要整理的任务", null, createdAt, callId, 1);
        audit(callId, "suggestions_generated", { actorType: "system", actorId: "board-manager-empty-input" }, { suggestionCount: 0 });
      }
    });
    if (replayed || get(callId).call.status === "completed") return { ...get(callId), replayed };

    let boundThreadId = null;
    try {
      const result = await launcher.launch({
        cwd,
        prompt: buildInboxOrganizerPrompt(get(callId).call.input),
        sandbox: "read-only",
        approvalPolicy: "never",
        onThreadReady: async ({ threadId }) => {
          boundThreadId = threadId;
          updateLocation(callId, { status: "running", threadId });
          onManagerThread?.(threadId);
        },
        onTurnStarted: ({ threadId, turnId }) => updateLocation(callId, { status: "running", threadId, turnId }),
        onTurnCompleted: (event) => finish(callId, event),
        onLifecycleError: (error) => console.error(`Board Manager call ${callId} lifecycle failed`, error),
      });
      return { ...get(callId), replayed: false, deepLink: result.deepLink };
    } catch (error) {
      transaction(db, () => {
        const row = findCall.get(callId);
        const status = boundThreadId ? "uncertain" : "failed";
        completeCall.run(status, "", error instanceof Error ? error.message : String(error), now(), callId, row.version);
        audit(callId, "launch_failed", { actorType: "system", actorId: "board-manager-launcher" }, { uncertain: Boolean(boundThreadId) });
      });
      const wrapped = new WorkItemError(502, boundThreadId ? "看板管家启动结果不确定，请查看调用记录，勿自动重试" : "看板管家启动失败", boundThreadId ? "manager_launch_uncertain" : "manager_launch_failed");
      wrapped.details = get(callId);
      throw wrapped;
    }
  }

  function apply(id, input = {}, actorInput = {}) {
    const actor = attribution(actorInput);
    if (actor.actorType !== "user") throw new WorkItemError(403, "只有用户可以确认管家建议", "user_confirmation_required");
    if (!input.idempotencyKey || !String(input.idempotencyKey).trim()) throw new WorkItemError(400, "必须提供 idempotencyKey", "missing_idempotency_key");
    if (!Array.isArray(input.suggestionIds) || !input.suggestionIds.length) throw new WorkItemError(400, "请选择要应用的建议", "missing_suggestions");
    const suggestionIds = [...new Set(input.suggestionIds.map((item) => String(item)))].sort();
    const operation = `board_manager.apply:${id}`;
    const key = String(input.idempotencyKey).trim().slice(0, 200);
    const hash = requestHash({ suggestionIds });
    return transaction(db, () => {
      const existing = findIdempotency.get(operation, key);
      if (existing) {
        if (existing.request_hash !== hash) throw new WorkItemError(409, "相同幂等键对应了不同请求", "idempotency_conflict");
        return { ...parseJson(existing.response_json, {}), replayed: true };
      }
      const callRow = findCall.get(id);
      if (!callRow) throw new WorkItemError(404, "看板管家调用不存在", "manager_call_not_found");
      const call = mapCall(callRow);
      if (call.status !== "completed") throw new WorkItemError(409, "看板管家尚未生成可应用建议", "manager_call_not_completed");
      const suggestions = suggestionIds.map((suggestionId) => {
        const row = findSuggestion.get(suggestionId, id);
        if (!row) throw new WorkItemError(404, "管家建议不存在", "manager_suggestion_not_found");
        return mapSuggestion(row);
      });
      if (suggestions.some((suggestion) => suggestion.kind !== "update_work_item")) throw new WorkItemError(409, "疑似重复建议当前只供判断，不能自动合并", "manager_suggestion_requires_manual_resolution");
      if (suggestions.some((suggestion) => suggestion.state !== "pending")) throw new WorkItemError(409, "所选建议已经应用", "manager_suggestion_already_applied");
      const updatedWorkItems = [];
      for (const suggestion of suggestions) {
        updatedWorkItems.push(workItems.update(suggestion.workItemId, suggestion.expectedWorkItemVersion, suggestion.patch, actor));
        if (Number(markSuggestionApplied.run(now(), suggestion.id).changes) !== 1) throw new WorkItemError(409, "管家建议状态冲突", "manager_suggestion_conflict");
      }
      const response = { callId: id, suggestionIds, updatedWorkItems };
      insertIdempotency.run(operation, key, hash, JSON.stringify(response), now());
      audit(id, "suggestions_applied", actor, { suggestionIds, workItemIds: updatedWorkItems.map((item) => item.id) });
      return { ...response, replayed: false };
    });
  }

  return {
    organizeInbox,
    get,
    latest() { const row = latestCall.get(CALL_ACTION); return row ? get(row.id) : null; },
    apply,
    listAudit(id) { if (!findCall.get(id)) throw new WorkItemError(404, "看板管家调用不存在", "manager_call_not_found"); return listAudit.all(id).map(mapAudit); },
  };
}
