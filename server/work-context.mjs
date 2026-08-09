import { createHash, randomUUID } from "node:crypto";
import { WorkItemError } from "./work-items.mjs";

let savepointSequence = 0;

function transaction(db, operation) {
  const savepoint = `work_context_${++savepointSequence}`;
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

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function hash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function attribution(input = {}) {
  const actorType = input.actorType || "user";
  if (!["user", "codex", "system"].includes(actorType)) throw new WorkItemError(400, "无效的 actor type", "invalid_actor_type");
  const threadId = input.threadId ? String(input.threadId).trim().slice(0, 200) : null;
  if (actorType === "codex" && !threadId) throw new WorkItemError(400, "Codex 写操作必须提供来源 thread ID", "missing_thread_id");
  return { actorType, actorId: String(input.actorId || "local-user").trim().slice(0, 200), threadId };
}

function strings(value, field) {
  if (!Array.isArray(value)) throw new WorkItemError(400, `${field} 必须是数组`, `invalid_${field}`);
  return value.map((item) => String(item).trim().slice(0, 2_000)).filter(Boolean).slice(0, 100);
}

export function buildContextEnvelopePrompt(envelope, { runId } = {}) {
  return [
    "你正在执行看板中的一个 Work Item。看板数据是工作任务的真相源，本次 Codex task 只是执行容器。",
    `Run ID: ${runId || "未提供"}`,
    `Context Envelope version: ${envelope.contextVersion}; Work Item version: ${envelope.workItem.version}`,
    "以下 Context Envelope 是本次 Run 创建时冻结的完整任务上下文。只按其中的目标、范围、决定、约束和停止条件工作；不要从旧对话自行补全或扩大范围。",
    "如果信息不足、触发停止条件或需要改变任务范围，请停止执行并在“需要用户决定”中明确提出，不要替用户作决定。",
    "最终按 reportFormat 汇报，给出可核验的结果或引用；不要声称已把 Work Item 移到 done。",
    "",
    "<context-envelope>",
    JSON.stringify(envelope, null, 2),
    "</context-envelope>",
  ].join("\n");
}

export function initWorkContextSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_item_decisions (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_items(id),
      decision TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      codex_thread_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_work_item ON work_item_decisions(work_item_id, created_at);
    CREATE TABLE IF NOT EXISTS work_item_recovery_points (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_items(id),
      source_run_id TEXT REFERENCES work_item_runs(id),
      work_item_version INTEGER NOT NULL,
      current_goal TEXT NOT NULL,
      current_conclusion TEXT NOT NULL DEFAULT '',
      completed TEXT NOT NULL DEFAULT '[]',
      unresolved TEXT NOT NULL DEFAULT '[]',
      next_action TEXT NOT NULL,
      resource_refs TEXT NOT NULL DEFAULT '[]',
      version INTEGER NOT NULL DEFAULT 1,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      codex_thread_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recovery_work_item ON work_item_recovery_points(work_item_id, created_at);
    CREATE TABLE IF NOT EXISTS work_item_relations (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_items(id),
      target_work_item_id TEXT NOT NULL REFERENCES work_items(id),
      relation_type TEXT NOT NULL CHECK (relation_type IN ('parent','blocked_by','related')),
      version INTEGER NOT NULL DEFAULT 1,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      codex_thread_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(work_item_id, target_work_item_id, relation_type)
    );
    CREATE INDEX IF NOT EXISTS idx_relations_work_item ON work_item_relations(work_item_id, created_at);
    CREATE TABLE IF NOT EXISTS work_item_evidence_refs (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_items(id),
      run_id TEXT REFERENCES work_item_runs(id),
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      uri TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      codex_thread_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_work_item ON work_item_evidence_refs(work_item_id, created_at);
    CREATE TABLE IF NOT EXISTS work_context_idempotency (
      operation TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(operation, idempotency_key)
    );
  `);
}

function mapAttributed(row) {
  return {
    version: row.version,
    actorType: row.actor_type,
    actorId: row.actor_id,
    codexThreadId: row.codex_thread_id,
    createdAt: row.created_at,
  };
}

export function createWorkContextRepository(db, workItems) {
  const findIdempotency = db.prepare("SELECT * FROM work_context_idempotency WHERE operation=? AND idempotency_key=?");
  const insertIdempotency = db.prepare("INSERT INTO work_context_idempotency VALUES (?,?,?,?,?)");
  const listDecisions = db.prepare("SELECT * FROM work_item_decisions WHERE work_item_id=? ORDER BY rowid");
  const listRecovery = db.prepare("SELECT * FROM work_item_recovery_points WHERE work_item_id=? ORDER BY rowid");
  const listRelations = db.prepare("SELECT * FROM work_item_relations WHERE work_item_id=? ORDER BY rowid");
  const listEvidence = db.prepare("SELECT * FROM work_item_evidence_refs WHERE work_item_id=? ORDER BY rowid");

  function idempotent(operation, key, request, perform) {
    if (!key || !String(key).trim()) throw new WorkItemError(400, "必须提供 idempotencyKey", "missing_idempotency_key");
    const normalizedKey = String(key).trim().slice(0, 200);
    const requestHash = hash(request);
    return transaction(db, () => {
      const existing = findIdempotency.get(operation, normalizedKey);
      if (existing) {
        if (existing.request_hash !== requestHash) throw new WorkItemError(409, "相同幂等键对应了不同请求", "idempotency_conflict");
        return parseJson(existing.response_json, null);
      }
      const response = perform();
      insertIdempotency.run(operation, normalizedKey, requestHash, JSON.stringify(response), new Date().toISOString());
      return response;
    });
  }

  function current(id, expectedVersion) {
    const item = workItems.get(id);
    if (!item) throw new WorkItemError(404, "工作任务不存在", "work_item_not_found");
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new WorkItemError(400, "必须提供有效的 expectedVersion", "invalid_expected_version");
    if (item.version !== expectedVersion) throw new WorkItemError(409, "工作任务已被其他操作修改，请重新读取", "version_conflict");
    return item;
  }

  function createDecision(workItemId, input, attributionInput, key) {
    const request = { workItemId, expectedVersion: input.expectedVersion, decision: String(input.decision || "").trim().slice(0, 10_000), reason: String(input.reason || "").slice(0, 10_000) };
    if (!request.decision) throw new WorkItemError(400, "decision 不能为空", "invalid_decision");
    return idempotent(`decision.create:${workItemId}`, key, request, () => {
      current(workItemId, request.expectedVersion);
      const actor = attribution(attributionInput);
      if (actor.actorType === "codex") throw new WorkItemError(403, "Codex 只能提出决定请求，不能代替用户记录决定", "user_confirmation_required");
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      db.prepare("INSERT INTO work_item_decisions VALUES (?,?,?,?,?,?,?,?,?)").run(id, workItemId, request.decision, request.reason, 1, actor.actorType, actor.actorId, actor.threadId, createdAt);
      workItems.update(workItemId, request.expectedVersion, {}, attributionInput);
      return { id, workItemId, decision: request.decision, reason: request.reason, version: 1, actorType: actor.actorType, actorId: actor.actorId, codexThreadId: actor.threadId, createdAt };
    });
  }

  function createRecoveryPoint(workItemId, input, attributionInput, key) {
    const request = {
      workItemId,
      expectedVersion: input.expectedVersion,
      sourceRunId: input.sourceRunId || null,
      currentConclusion: String(input.currentConclusion || ""),
      completed: strings(input.completed || [], "completed"),
      unresolved: strings(input.unresolved || [], "unresolved"),
      nextAction: String(input.nextAction || "").trim(),
      resourceRefs: strings(input.resourceRefs || [], "resourceRefs"),
      status: input.status || null,
    };
    if (!request.nextAction) throw new WorkItemError(400, "Recovery Point 必须包含下一步唯一动作", "invalid_recovery_point");
    if (request.status !== null && !["parked", "blocked", "ready"].includes(request.status)) throw new WorkItemError(400, "恢复点状态只能是 parked、blocked 或 ready", "invalid_recovery_status");
    return idempotent(`recovery.create:${workItemId}`, key, request, () => {
      const item = current(workItemId, request.expectedVersion);
      if (request.sourceRunId && workItems.getRun(request.sourceRunId)?.workItemId !== workItemId) throw new WorkItemError(400, "sourceRunId 不属于当前任务", "invalid_source_run");
      const actor = attribution(attributionInput);
      if (actor.actorType === "codex" && request.status && request.status !== item.status) {
        throw new WorkItemError(403, "Codex 可以保存 Recovery Point，但改变 Work Status 需要用户确认", "user_confirmation_required");
      }
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      db.prepare(`INSERT INTO work_item_recovery_points
        (id,work_item_id,source_run_id,work_item_version,current_goal,current_conclusion,completed,unresolved,next_action,resource_refs,version,actor_type,actor_id,codex_thread_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, workItemId, request.sourceRunId, item.version, item.goal, request.currentConclusion, JSON.stringify(request.completed),
        JSON.stringify(request.unresolved), request.nextAction, JSON.stringify(request.resourceRefs), 1, actor.actorType, actor.actorId, actor.threadId, createdAt,
      );
      const updatedWorkItem = workItems.update(workItemId, request.expectedVersion, {
        nextAction: request.nextAction,
        ...(request.status ? { status: request.status } : {}),
      }, attributionInput);
      return { id, workItemId, sourceRunId: request.sourceRunId, workItemVersion: item.version, currentGoal: item.goal, currentConclusion: request.currentConclusion, completed: request.completed, unresolved: request.unresolved, nextAction: request.nextAction, resourceRefs: request.resourceRefs, version: 1, actorType: actor.actorType, actorId: actor.actorId, codexThreadId: actor.threadId, createdAt, resultingWorkItemVersion: updatedWorkItem.version };
    });
  }

  function createRelation(workItemId, input, attributionInput, key) {
    const request = { workItemId, expectedVersion: input.expectedVersion, targetWorkItemId: input.targetWorkItemId, relationType: input.relationType };
    if (!request.targetWorkItemId || request.targetWorkItemId === workItemId) throw new WorkItemError(400, "关系目标无效", "invalid_relation_target");
    if (!["parent", "blocked_by", "related"].includes(request.relationType)) throw new WorkItemError(400, "关系类型无效", "invalid_relation_type");
    return idempotent(`relation.create:${workItemId}`, key, request, () => {
      current(workItemId, request.expectedVersion);
      if (!workItems.get(request.targetWorkItemId)) throw new WorkItemError(404, "关系目标任务不存在", "relation_target_not_found");
      const actor = attribution(attributionInput);
      if (actor.actorType === "codex") throw new WorkItemError(403, "Codex 不能未经用户确认修改任务关系", "user_confirmation_required");
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      db.prepare("INSERT INTO work_item_relations VALUES (?,?,?,?,?,?,?,?,?)").run(id, workItemId, request.targetWorkItemId, request.relationType, 1, actor.actorType, actor.actorId, actor.threadId, createdAt);
      workItems.update(workItemId, request.expectedVersion, {}, attributionInput);
      return { id, workItemId, targetWorkItemId: request.targetWorkItemId, relationType: request.relationType, version: 1, actorType: actor.actorType, actorId: actor.actorId, codexThreadId: actor.threadId, createdAt };
    });
  }

  function createEvidence(workItemId, input, attributionInput, key) {
    const request = { workItemId, expectedVersion: input.expectedVersion, runId: input.runId || null, kind: String(input.kind || "reference").slice(0, 100), label: String(input.label || "").trim().slice(0, 300), uri: String(input.uri || "").trim(), summary: String(input.summary || "") };
    if (!request.label || !request.uri) throw new WorkItemError(400, "证据必须包含 label 和 uri", "invalid_evidence");
    if (request.uri.length > 2_000 || request.uri.startsWith("data:")) throw new WorkItemError(400, "证据必须使用简短引用 URI，不能内嵌原始内容", "invalid_evidence_uri");
    if (request.summary.length > 2000) throw new WorkItemError(400, "证据摘要过长，请保存引用而不是原始内容", "evidence_summary_too_large");
    return idempotent(`evidence.create:${workItemId}`, key, request, () => {
      current(workItemId, request.expectedVersion);
      if (request.runId && workItems.getRun(request.runId)?.workItemId !== workItemId) throw new WorkItemError(400, "runId 不属于当前任务", "invalid_evidence_run");
      const actor = attribution(attributionInput);
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      db.prepare("INSERT INTO work_item_evidence_refs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(id, workItemId, request.runId, request.kind, request.label, request.uri, request.summary, 1, actor.actorType, actor.actorId, actor.threadId, createdAt);
      workItems.update(workItemId, request.expectedVersion, {}, attributionInput);
      return { id, workItemId, runId: request.runId, kind: request.kind, label: request.label, uri: request.uri, summary: request.summary, version: 1, actorType: actor.actorType, actorId: actor.actorId, codexThreadId: actor.threadId, createdAt };
    });
  }

  function context(workItemId) {
    if (!workItems.get(workItemId)) throw new WorkItemError(404, "工作任务不存在", "work_item_not_found");
    return {
      decisions: listDecisions.all(workItemId).map((row) => ({ id: row.id, workItemId: row.work_item_id, decision: row.decision, reason: row.reason, ...mapAttributed(row) })),
      recoveryPoints: listRecovery.all(workItemId).map((row) => ({ id: row.id, workItemId: row.work_item_id, sourceRunId: row.source_run_id, workItemVersion: row.work_item_version, currentGoal: row.current_goal, currentConclusion: row.current_conclusion, completed: parseJson(row.completed, []), unresolved: parseJson(row.unresolved, []), nextAction: row.next_action, resourceRefs: parseJson(row.resource_refs, []), ...mapAttributed(row) })),
      relations: listRelations.all(workItemId).map((row) => ({ id: row.id, workItemId: row.work_item_id, targetWorkItemId: row.target_work_item_id, relationType: row.relation_type, ...mapAttributed(row) })),
      evidence: listEvidence.all(workItemId).map((row) => ({ id: row.id, workItemId: row.work_item_id, runId: row.run_id, kind: row.kind, label: row.label, uri: row.uri, summary: row.summary, ...mapAttributed(row) })),
    };
  }

  function readiness(workItemId, mode = "implementation") {
    if (!["explore", "implementation"].includes(mode)) throw new WorkItemError(400, "无效的 Run mode", "invalid_run_mode");
    const item = workItems.get(workItemId);
    if (!item) throw new WorkItemError(404, "工作任务不存在", "work_item_not_found");
    const missing = [];
    if (!item.goal.trim()) missing.push("goal");
    if (!item.nextAction.trim()) missing.push("nextAction");
    if (!item.acceptanceCriteria.length) missing.push("acceptanceCriteria");
    if (!item.scope.allowed.trim()) missing.push("scope.allowed");
    return { ready: mode === "explore" || missing.length === 0, mode, missing, suggestedMode: missing.length ? "explore" : mode };
  }

  function buildEnvelope(workItemId, run = {}) {
    const item = workItems.get(workItemId);
    if (!item) throw new WorkItemError(404, "工作任务不存在", "work_item_not_found");
    if (run.expectedVersion !== undefined && run.expectedVersion !== item.version) throw new WorkItemError(409, "工作任务已被其他操作修改，请重新读取", "version_conflict");
    const mode = run.mode || "implementation";
    const check = readiness(workItemId, mode);
    if (!check.ready) {
      const error = new WorkItemError(409, `任务尚未准备好执行：缺少 ${check.missing.join(", ")}`, "work_item_not_ready");
      error.details = check;
      throw error;
    }
    const stored = context(workItemId);
    const latestRecovery = stored.recoveryPoints.at(-1) || null;
    const groupedRelations = { parent: null, blockedBy: [], related: [] };
    for (const relation of stored.relations) {
      if (relation.relationType === "parent") groupedRelations.parent = relation.targetWorkItemId;
      if (relation.relationType === "blocked_by") groupedRelations.blockedBy.push(relation.targetWorkItemId);
      if (relation.relationType === "related") groupedRelations.related.push(relation.targetWorkItemId);
    }
    return {
      contextVersion: 1,
      generatedAt: new Date().toISOString(),
      workItem: { id: item.id, version: item.version, title: item.title, goal: item.goal || "未提供", stage: item.stage, status: item.status, nextAction: item.nextAction || "未提供" },
      acceptance: { criteria: item.acceptanceCriteria.length ? item.acceptanceCriteria : ["未提供"] },
      scope: mode === "explore"
        ? { allowed: `只读探索：${item.scope.allowed || "仅收集信息和澄清问题"}`, excluded: item.scope.excluded || "不得修改代码、数据或外部系统", stopConditions: item.stopConditions }
        : { allowed: item.scope.allowed || "未提供", excluded: item.scope.excluded || "未提供", stopConditions: item.stopConditions },
      decisions: stored.decisions.map(({ id, decision, reason }) => ({ id, decision, reason })),
      constraints: item.constraints,
      recoveryPoint: latestRecovery ? { id: latestRecovery.id, currentConclusion: latestRecovery.currentConclusion, completed: latestRecovery.completed, unresolved: latestRecovery.unresolved, nextAction: latestRecovery.nextAction, resourceRefs: latestRecovery.resourceRefs } : null,
      relations: groupedRelations,
      evidenceRefs: stored.evidence.map(({ id, kind, label, uri, summary }) => ({ id, kind, label, uri, summary })),
      summarySources: [{ type: "work_item", id: item.id, version: item.version }, ...stored.decisions.map((entry) => ({ type: "decision", id: entry.id, version: entry.version })), ...(latestRecovery ? [{ type: "recovery_point", id: latestRecovery.id, version: latestRecovery.version }] : []), ...stored.relations.map((entry) => ({ type: "relation", id: entry.id, version: entry.version })), ...stored.evidence.map((entry) => ({ type: "evidence_ref", id: entry.id, version: entry.version }))],
      run: { mode, objective: run.objective || item.nextAction || item.goal || "探索并澄清任务", expectedOutput: run.expectedOutput || (mode === "explore" ? "问题定义、关键发现、风险与建议下一步" : "按验收标准提交结果和验证证据"), reportFormat: ["已完成", "验证结果", "风险", "需要用户决定", "下一步"] },
    };
  }

  return { context, readiness, buildEnvelope, createDecision, createRecoveryPoint, createRelation, createEvidence };
}
