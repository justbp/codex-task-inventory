import { createHash, randomUUID } from "node:crypto";
import { WorkItemError } from "./work-items.mjs";

let savepointSequence = 0;

function transaction(db, operation) {
  const savepoint = `work_decision_${++savepointSequence}`;
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

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function requestHash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function now() {
  return new Date().toISOString();
}

function normalizeAttribution(input = {}) {
  const actorType = input.actorType || "user";
  if (!["user", "codex", "system"].includes(actorType)) throw new WorkItemError(400, "无效的 actor type", "invalid_actor_type");
  const actorId = String(input.actorId || (actorType === "user" ? "local-user" : actorType)).trim().slice(0, 200);
  const threadId = input.threadId ? String(input.threadId).trim().slice(0, 200) : null;
  if (actorType === "codex" && !threadId) throw new WorkItemError(400, "Codex 写操作必须提供来源 thread ID", "missing_thread_id");
  return { actorType, actorId, threadId };
}

function requiredVersion(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new WorkItemError(400, `必须提供有效的 ${field}`, "invalid_expected_version");
  return value;
}

function normalizeOptions(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 5) {
    throw new WorkItemError(400, "Decision Request 必须提供 2 至 5 个选项", "invalid_decision_options");
  }
  const ids = new Set();
  return value.map((option, index) => {
    if (!option || typeof option !== "object" || Array.isArray(option)) throw new WorkItemError(400, "决定选项格式无效", "invalid_decision_options");
    const id = String(option.id || `option-${index + 1}`).trim().slice(0, 100);
    const label = String(option.label || "").trim().slice(0, 300);
    if (!id || !label || ids.has(id)) throw new WorkItemError(400, "决定选项必须具有唯一 id 和非空 label", "invalid_decision_options");
    ids.add(id);
    return { id, label, description: String(option.description || "").trim().slice(0, 2_000) };
  });
}

export function initWorkDecisionSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_item_decision_requests (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_items(id),
      run_id TEXT NOT NULL REFERENCES work_item_runs(id),
      question TEXT NOT NULL,
      context_summary TEXT NOT NULL DEFAULT '',
      options TEXT NOT NULL,
      recommended_option_id TEXT,
      recommendation_reason TEXT NOT NULL DEFAULT '',
      risks TEXT NOT NULL DEFAULT '',
      default_consequence TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','answered','canceled')),
      routing_state TEXT NOT NULL DEFAULT 'not_requested' CHECK (routing_state IN ('not_requested','routing','routed','failed','uncertain')),
      routing_error TEXT,
      source_thread_id TEXT NOT NULL,
      source_turn_id TEXT NOT NULL,
      answer_option_id TEXT,
      answer_text TEXT,
      answer_thread_id TEXT,
      answer_turn_id TEXT,
      answered_by_type TEXT,
      answered_by_id TEXT,
      answered_at TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      codex_thread_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_decision_requests_work_item ON work_item_decision_requests(work_item_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_decision_requests_run ON work_item_decision_requests(run_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_requests_pending_run ON work_item_decision_requests(run_id) WHERE status='pending';
    CREATE TABLE IF NOT EXISTS work_item_decision_request_audit (
      id TEXT PRIMARY KEY,
      decision_request_id TEXT NOT NULL REFERENCES work_item_decision_requests(id),
      action TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      codex_thread_id TEXT,
      before_version INTEGER,
      after_version INTEGER,
      before_json TEXT,
      after_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_decision_request_audit ON work_item_decision_request_audit(decision_request_id, created_at);
    CREATE TABLE IF NOT EXISTS work_decision_idempotency (
      operation TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(operation, idempotency_key)
    );
  `);
}

function mapRequest(row) {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    runId: row.run_id,
    question: row.question,
    contextSummary: row.context_summary,
    options: parseJson(row.options, []),
    recommendedOptionId: row.recommended_option_id,
    recommendationReason: row.recommendation_reason,
    risks: row.risks,
    defaultConsequence: row.default_consequence,
    status: row.status,
    routingState: row.routing_state,
    routingError: row.routing_error,
    sourceThreadId: row.source_thread_id,
    sourceTurnId: row.source_turn_id,
    sourceUri: `codex://threads/${row.source_thread_id}?turn=${row.source_turn_id}`,
    answerOptionId: row.answer_option_id,
    answerText: row.answer_text,
    answerThreadId: row.answer_thread_id,
    answerTurnId: row.answer_turn_id,
    answerUri: row.answer_thread_id && row.answer_turn_id ? `codex://threads/${row.answer_thread_id}?turn=${row.answer_turn_id}` : null,
    answeredByType: row.answered_by_type,
    answeredById: row.answered_by_id,
    answeredAt: row.answered_at,
    version: row.version,
    actorType: row.actor_type,
    actorId: row.actor_id,
    codexThreadId: row.codex_thread_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function buildDecisionAnswerPrompt(request) {
  const selected = request.options.find((option) => option.id === request.answerOptionId) || null;
  return [
    "用户已经在任务看板回答了本 Run 的 Decision Request。看板中的结构化决定是事实来源。",
    `Decision Request ID: ${request.id}`,
    `原问题: ${request.question}`,
    `用户选择: ${selected ? `${selected.id} - ${selected.label}` : "未选择预设选项"}`,
    `用户补充: ${request.answerText || "无"}`,
    "请在原 Work Item 的既定目标、范围、约束和验收标准内继续执行。若该决定意味着扩大范围或新增权限，请再次停止并提出新的 Decision Request。",
    "完成后仍按既定结构提交验收，不要自行把 Work Item 标记为 done。",
  ].join("\n");
}

export function createWorkDecisionRepository(db, workItems) {
  const findRequest = db.prepare("SELECT * FROM work_item_decision_requests WHERE id=?");
  const findPendingByRun = db.prepare("SELECT * FROM work_item_decision_requests WHERE run_id=? AND status='pending' ORDER BY rowid DESC LIMIT 1");
  const findUnroutedByRun = db.prepare("SELECT * FROM work_item_decision_requests WHERE run_id=? AND status IN ('pending','answered') AND routing_state!='routed' ORDER BY rowid DESC LIMIT 1");
  const listByRun = db.prepare("SELECT * FROM work_item_decision_requests WHERE run_id=? ORDER BY rowid");
  const listByWorkItem = db.prepare("SELECT * FROM work_item_decision_requests WHERE work_item_id=? ORDER BY rowid");
  const listAudit = db.prepare("SELECT * FROM work_item_decision_request_audit WHERE decision_request_id=? ORDER BY rowid");
  const findIdempotency = db.prepare("SELECT * FROM work_decision_idempotency WHERE operation=? AND idempotency_key=?");
  const insertIdempotency = db.prepare("INSERT INTO work_decision_idempotency VALUES (?,?,?,?,?)");
  const insertRequest = db.prepare(`INSERT INTO work_item_decision_requests
    (id,work_item_id,run_id,question,context_summary,options,recommended_option_id,recommendation_reason,risks,default_consequence,status,routing_state,source_thread_id,source_turn_id,version,actor_type,actor_id,codex_thread_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const updateAnswer = db.prepare(`UPDATE work_item_decision_requests SET
    status='answered',routing_state='routing',routing_error=NULL,answer_option_id=?,answer_text=?,answered_by_type=?,answered_by_id=?,answered_at=?,version=version+1,updated_at=?
    WHERE id=? AND version=? AND status='pending'`);
  const updateRouting = db.prepare(`UPDATE work_item_decision_requests SET
    routing_state=?,routing_error=?,answer_thread_id=?,answer_turn_id=?,version=version+1,updated_at=? WHERE id=? AND version=?`);
  const insertDecision = db.prepare(`INSERT INTO work_item_decisions
    (id,work_item_id,decision,reason,version,actor_type,actor_id,codex_thread_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)`);
  const insertAudit = db.prepare(`INSERT INTO work_item_decision_request_audit
    (id,decision_request_id,action,actor_type,actor_id,codex_thread_id,before_version,after_version,before_json,after_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

  function audit(action, actor, before, after) {
    insertAudit.run(randomUUID(), after?.id || before.id, action, actor.actorType, actor.actorId, actor.threadId,
      before?.version ?? null, after?.version ?? null, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, now());
  }

  function claimIdempotency(operation, key, request, entityId = null) {
    if (!key || !String(key).trim()) throw new WorkItemError(400, "必须提供 idempotencyKey", "missing_idempotency_key");
    const normalizedKey = String(key).trim().slice(0, 200);
    const hash = requestHash(request);
    const existing = findIdempotency.get(operation, normalizedKey);
    if (existing) {
      if (existing.request_hash !== hash) throw new WorkItemError(409, "相同幂等键对应了不同请求", "idempotency_conflict");
      return { replayed: true, entityId: existing.entity_id };
    }
    if (entityId) insertIdempotency.run(operation, normalizedKey, hash, entityId, now());
    return { replayed: false, normalizedKey, hash };
  }

  function createRequest(runId, input, attributionInput, idempotencyKey) {
    const actor = normalizeAttribution(attributionInput);
    if (actor.actorType !== "codex" && actor.actorType !== "system") {
      throw new WorkItemError(403, "Decision Request 必须由 Codex Run 提交", "decision_request_requires_codex");
    }
    const options = normalizeOptions(input.options);
    const request = {
      runId,
      expectedRunVersion: requiredVersion(input.expectedRunVersion, "expectedRunVersion"),
      expectedWorkItemVersion: requiredVersion(input.expectedWorkItemVersion, "expectedWorkItemVersion"),
      question: String(input.question || "").trim().slice(0, 2_000),
      contextSummary: String(input.contextSummary || "").trim().slice(0, 2_000),
      options,
      recommendedOptionId: input.recommendedOptionId ? String(input.recommendedOptionId).trim().slice(0, 100) : null,
      recommendationReason: String(input.recommendationReason || "").trim().slice(0, 2_000),
      risks: String(input.risks || "").trim().slice(0, 2_000),
      defaultConsequence: String(input.defaultConsequence || "").trim().slice(0, 2_000),
      sourceTurnId: String(input.sourceTurnId || "").trim().slice(0, 200),
    };
    if (!request.question || !request.contextSummary || !request.sourceTurnId) throw new WorkItemError(400, "Decision Request 缺少问题、背景或来源 turn", "invalid_decision_request");
    if (request.recommendedOptionId && !options.some((option) => option.id === request.recommendedOptionId)) {
      throw new WorkItemError(400, "推荐选项不在 options 中", "invalid_recommended_option");
    }
    const operation = `decision_request.create:${runId}`;
    return transaction(db, () => {
      const replay = claimIdempotency(operation, idempotencyKey, request);
      if (replay.replayed) {
        const decisionRequest = mapRequest(findRequest.get(replay.entityId));
        return { decisionRequest, run: workItems.getRun(decisionRequest.runId), workItem: workItems.get(decisionRequest.workItemId), replayed: true };
      }
      const run = workItems.getRun(runId);
      if (!run) throw new WorkItemError(404, "运行记录不存在", "run_not_found");
      const item = workItems.get(run.workItemId);
      if (run.version !== request.expectedRunVersion || item.version !== request.expectedWorkItemVersion) {
        throw new WorkItemError(409, "Run 或 Work Item 已被其他操作修改，请重新读取", "version_conflict");
      }
      if (run.status !== "running" || run.terminalEventKey) throw new WorkItemError(409, "只有执行中的 Run 可以请求决定", "run_not_running");
      if (run.codexThreadId !== actor.threadId || run.codexTurnId !== request.sourceTurnId) {
        throw new WorkItemError(409, "Decision Request 来源与 Run 绑定的 thread/turn 不匹配", "decision_source_mismatch");
      }
      if (findPendingByRun.get(runId)) throw new WorkItemError(409, "该 Run 已有待回答的 Decision Request", "pending_decision_exists");
      const id = randomUUID();
      const createdAt = now();
      insertRequest.run(id, run.workItemId, runId, request.question, request.contextSummary, JSON.stringify(options), request.recommendedOptionId,
        request.recommendationReason, request.risks, request.defaultConsequence, "pending", "not_requested", run.codexThreadId,
        request.sourceTurnId, 1, actor.actorType, actor.actorId, actor.threadId, createdAt, createdAt);
      const created = mapRequest(findRequest.get(id));
      audit("create", actor, null, created);
      const waitingRun = workItems.updateRun(runId, run.version, { status: "waiting" }, { actorType: "system", actorId: "decision-request", threadId: actor.threadId });
      const awaitingWorkItem = workItems.update(item.id, item.version, { status: "awaiting_decision" }, { actorType: "system", actorId: "decision-request", threadId: actor.threadId });
      insertIdempotency.run(operation, replay.normalizedKey, replay.hash, id, now());
      return { decisionRequest: created, run: waitingRun, workItem: awaitingWorkItem, replayed: false };
    });
  }

  function claimAnswer(id, input, attributionInput, idempotencyKey) {
    const actor = normalizeAttribution(attributionInput);
    if (actor.actorType !== "user") throw new WorkItemError(403, "决定必须由用户回答", "user_confirmation_required");
    const request = {
      id,
      expectedVersion: requiredVersion(input.expectedVersion, "expectedVersion"),
      expectedRunVersion: requiredVersion(input.expectedRunVersion, "expectedRunVersion"),
      expectedWorkItemVersion: requiredVersion(input.expectedWorkItemVersion, "expectedWorkItemVersion"),
      optionId: input.optionId ? String(input.optionId).trim().slice(0, 100) : null,
      answerText: String(input.answerText || "").trim().slice(0, 4_000),
    };
    if (!request.optionId && !request.answerText) throw new WorkItemError(400, "请选择选项或填写回答", "invalid_decision_answer");
    const operation = `decision_request.answer:${id}`;
    return transaction(db, () => {
      const replay = claimIdempotency(operation, idempotencyKey, request);
      if (replay.replayed) return { decisionRequest: mapRequest(findRequest.get(replay.entityId)), replayed: true };
      const row = findRequest.get(id);
      if (!row) throw new WorkItemError(404, "Decision Request 不存在", "decision_request_not_found");
      const current = mapRequest(row);
      if (current.version !== request.expectedVersion) throw new WorkItemError(409, "Decision Request 已被其他操作修改，请重新读取", "version_conflict");
      const run = workItems.getRun(current.runId);
      const item = workItems.get(current.workItemId);
      if (run.version !== request.expectedRunVersion || item.version !== request.expectedWorkItemVersion) {
        throw new WorkItemError(409, "Run 或 Work Item 已被其他操作修改，请重新读取", "version_conflict");
      }
      if (current.status !== "pending" || run.status !== "waiting" || item.status !== "awaiting_decision") {
        throw new WorkItemError(409, "该决定当前不可回答", "decision_not_pending");
      }
      if (request.optionId && !current.options.some((option) => option.id === request.optionId)) throw new WorkItemError(400, "所选 optionId 不存在", "invalid_decision_option");
      const answeredAt = now();
      const update = updateAnswer.run(request.optionId, request.answerText, actor.actorType, actor.actorId, answeredAt, answeredAt, id, current.version);
      if (Number(update.changes) !== 1) throw new WorkItemError(409, "Decision Request 已被其他操作修改", "version_conflict");
      const answered = mapRequest(findRequest.get(id));
      const selected = answered.options.find((option) => option.id === answered.answerOptionId);
      const decisionText = selected ? `${selected.label}${answered.answerText ? `；${answered.answerText}` : ""}` : answered.answerText;
      insertDecision.run(randomUUID(), current.workItemId, decisionText, `回答 Decision Request ${id}：${current.question}`.slice(0, 10_000),
        1, actor.actorType, actor.actorId, current.sourceThreadId, answeredAt);
      workItems.update(item.id, item.version, {}, actor);
      audit("answer_claimed", actor, current, answered);
      insertIdempotency.run(operation, replay.normalizedKey, replay.hash, id, now());
      return { decisionRequest: answered, replayed: false };
    });
  }

  function recordRouting(id, expectedVersion, change, attributionInput = { actorType: "system", actorId: "decision-router" }) {
    const actor = normalizeAttribution(attributionInput);
    return transaction(db, () => {
      const row = findRequest.get(id);
      if (!row) throw new WorkItemError(404, "Decision Request 不存在", "decision_request_not_found");
      const current = mapRequest(row);
      if (current.version !== expectedVersion) throw new WorkItemError(409, "Decision Request 已被其他操作修改", "version_conflict");
      if (!["routing", "routed", "failed", "uncertain"].includes(change.routingState)) throw new WorkItemError(400, "无效的回答路由状态", "invalid_routing_state");
      const threadId = change.answerThreadId === undefined ? current.answerThreadId : change.answerThreadId;
      const turnId = change.answerTurnId === undefined ? current.answerTurnId : change.answerTurnId;
      if (threadId && threadId !== current.sourceThreadId) throw new WorkItemError(409, "回答不能路由到其他 Codex task", "decision_route_mismatch");
      const result = updateRouting.run(change.routingState, change.routingError ? String(change.routingError).slice(0, 4_000) : null,
        threadId, turnId, now(), id, current.version);
      if (Number(result.changes) !== 1) throw new WorkItemError(409, "Decision Request 已被其他操作修改", "version_conflict");
      const updated = mapRequest(findRequest.get(id));
      audit(`route_${change.routingState}`, actor, current, updated);
      return updated;
    });
  }

  return {
    createRequest,
    claimAnswer,
    recordRouting,
    get(id) { const row = findRequest.get(id); return row ? mapRequest(row) : null; },
    getPendingByRun(runId) { const row = findPendingByRun.get(runId); return row ? mapRequest(row) : null; },
    listByRun(runId) { if (!workItems.getRun(runId)) throw new WorkItemError(404, "运行记录不存在", "run_not_found"); return listByRun.all(runId).map(mapRequest); },
    listByWorkItem(workItemId) { if (!workItems.get(workItemId)) throw new WorkItemError(404, "工作任务不存在", "work_item_not_found"); return listByWorkItem.all(workItemId).map(mapRequest); },
    listAudit(id) {
      if (!findRequest.get(id)) throw new WorkItemError(404, "Decision Request 不存在", "decision_request_not_found");
      return listAudit.all(id).map((row) => ({
        id: row.id,
        decisionRequestId: row.decision_request_id,
        action: row.action,
        actorType: row.actor_type,
        actorId: row.actor_id,
        codexThreadId: row.codex_thread_id,
        beforeVersion: row.before_version,
        afterVersion: row.after_version,
        before: row.before_json ? parseJson(row.before_json, null) : null,
        after: row.after_json ? parseJson(row.after_json, null) : null,
        createdAt: row.created_at,
      }));
    },
    shouldDeferCompletion(runId, event) {
      const row = findUnroutedByRun.get(runId);
      const request = row ? mapRequest(row) : null;
      return Boolean(request && request.sourceThreadId === event.threadId && request.sourceTurnId === event.turnId);
    },
  };
}

export function createWorkDecisionRouter({ db, decisions, workItems, workReview, launcher }) {
  async function answer(id, input, attribution) {
    let claimed = decisions.claimAnswer(id, input, attribution, input.idempotencyKey);
    let request = decisions.get(id);
    if (claimed.replayed && request.routingState === "routed") return { decisionRequest: request, run: workItems.getRun(request.runId), workItem: workItems.get(request.workItemId), replayed: true };
    if (claimed.replayed && request.routingState !== "failed") {
      const error = new WorkItemError(409, "回答已经进入路由流程，请勿自动重复发送", request.routingState === "uncertain" ? "decision_route_uncertain" : "decision_route_in_progress");
      error.details = { decisionRequest: request };
      throw error;
    }
    const run = workItems.getRun(request.runId);
    const item = workItems.get(request.workItemId);
    let threadReady = false;
    try {
      const launched = await launcher.launch({
        cwd: item.cwd,
        prompt: buildDecisionAnswerPrompt(request),
        threadId: request.sourceThreadId,
        onThreadReady: ({ threadId }) => {
          if (threadId !== request.sourceThreadId) throw new WorkItemError(409, "Codex 恢复了错误的 task", "decision_route_mismatch");
          threadReady = true;
        },
        onTurnStarted: ({ threadId, turnId }) => {
          const currentRequest = decisions.get(id);
          const currentRun = workItems.getRun(run.id);
          const currentItem = workItems.get(item.id);
          transaction(db, () => {
            workItems.updateRun(currentRun.id, currentRun.version, { status: "running", codexThreadId: threadId, codexTurnId: turnId }, { actorType: "system", actorId: "decision-router", threadId });
            workItems.update(currentItem.id, currentItem.version, { status: "active" }, { actorType: "system", actorId: "decision-router", threadId });
            request = decisions.recordRouting(id, currentRequest.version, { routingState: "routed", answerThreadId: threadId, answerTurnId: turnId }, { actorType: "system", actorId: "decision-router", threadId });
          });
        },
        onTurnCompleted: (event) => workReview.processTurnCompleted(run.id, event),
        onLifecycleError: (error) => console.error(`Decision ${id} lifecycle synchronization failed`, error),
      });
      request = decisions.get(id);
      return { decisionRequest: request, run: workItems.getRun(run.id), workItem: workItems.get(item.id), replayed: claimed.replayed, deepLink: launched.deepLink };
    } catch (error) {
      request = decisions.get(id);
      if (request.routingState === "routed") throw error;
      request = decisions.recordRouting(id, request.version, {
        routingState: threadReady ? "uncertain" : "failed",
        routingError: error instanceof Error ? error.message : String(error),
        answerThreadId: threadReady ? request.sourceThreadId : null,
      });
      const wrapped = new WorkItemError(502, threadReady
        ? "决定回答的 Codex 路由结果不确定；请检查原 task，勿自动重试"
        : "决定已保存，但恢复原 Codex task 失败；可用同一幂等键安全重试",
      threadReady ? "decision_route_uncertain" : "decision_route_failed");
      wrapped.details = { decisionRequest: request };
      throw wrapped;
    }
  }

  return { answer };
}
