import { createHash, randomUUID } from "node:crypto";
import { WorkItemError } from "./work-items.mjs";

const ACTIONS = ["approve", "request_changes", "accept_with_follow_up"];
const STATES = ["applying", "applied", "failed", "uncertain"];
let savepointSequence = 0;

function transaction(db, operation) {
  const savepoint = `work_review_action_${++savepointSequence}`;
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

function expectedVersion(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new WorkItemError(400, `必须提供有效的 ${field}`, "invalid_expected_version");
  return value;
}

function attribution(input = {}) {
  const actorType = input.actorType || "user";
  if (actorType !== "user") throw new WorkItemError(403, "验收动作必须由用户明确执行", "user_confirmation_required");
  return {
    actorType,
    actorId: String(input.actorId || "local-user").trim().slice(0, 200),
    threadId: input.threadId ? String(input.threadId).trim().slice(0, 200) : null,
  };
}

function normalizeStringArray(value, field, limit = 50) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new WorkItemError(400, `${field} 必须是数组`, `invalid_${field}`);
  return value.map((entry) => String(entry).trim().slice(0, 2_000)).filter(Boolean).slice(0, limit);
}

function normalizeFollowUp(value = {}, original) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkItemError(400, "followUp 必须是对象", "invalid_follow_up");
  const title = String(value.title || "").trim().slice(0, 300);
  if (!title) throw new WorkItemError(400, "后续任务必须包含标题", "invalid_follow_up_title");
  const stage = value.stage || "explore";
  if (!["explore", "experiment", "execute", "verify"].includes(stage)) throw new WorkItemError(400, "后续任务 stage 无效", "invalid_follow_up_stage");
  return {
    title,
    description: String(value.description || "").slice(0, 10_000),
    goal: String(value.goal || "").slice(0, 10_000),
    nextAction: String(value.nextAction || "").slice(0, 2_000),
    acceptanceCriteria: normalizeStringArray(value.acceptanceCriteria, "acceptanceCriteria"),
    scope: {
      allowed: String(value.scope?.allowed || "").slice(0, 10_000),
      excluded: String(value.scope?.excluded || "").slice(0, 10_000),
    },
    stopConditions: normalizeStringArray(value.stopConditions, "stopConditions"),
    constraints: normalizeStringArray(value.constraints, "constraints"),
    status: "inbox",
    stage,
    project: value.project === undefined ? original.project : (value.project ? String(value.project).trim().slice(0, 120) : null),
    cwd: value.cwd === undefined ? original.cwd : (value.cwd ? String(value.cwd).trim().slice(0, 1_000) : null),
    tags: value.tags === undefined ? original.tags : normalizeStringArray(value.tags, "tags", 20),
    priority: value.priority || original.priority,
  };
}

export function initWorkReviewActionSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_item_review_actions (
      id TEXT PRIMARY KEY,
      review_submission_id TEXT NOT NULL UNIQUE REFERENCES work_item_review_submissions(id),
      work_item_id TEXT NOT NULL REFERENCES work_items(id),
      reviewed_run_id TEXT NOT NULL REFERENCES work_item_runs(id),
      action TEXT NOT NULL CHECK (action IN ('approve','request_changes','accept_with_follow_up')),
      state TEXT NOT NULL CHECK (state IN ('applying','applied','failed','uncertain')),
      feedback TEXT NOT NULL DEFAULT '',
      revision_run_id TEXT REFERENCES work_item_runs(id),
      follow_up_work_item_id TEXT REFERENCES work_items(id),
      source_uri TEXT NOT NULL,
      error TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      codex_thread_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_review_actions_work_item ON work_item_review_actions(work_item_id, created_at);
    CREATE TABLE IF NOT EXISTS work_item_review_action_audit (
      id TEXT PRIMARY KEY,
      review_action_id TEXT NOT NULL REFERENCES work_item_review_actions(id),
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
    CREATE INDEX IF NOT EXISTS idx_review_action_audit ON work_item_review_action_audit(review_action_id, created_at);
    CREATE TABLE IF NOT EXISTS work_review_action_idempotency (
      operation TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(operation, idempotency_key)
    );
  `);
}

function mapAction(row) {
  return {
    id: row.id,
    reviewSubmissionId: row.review_submission_id,
    workItemId: row.work_item_id,
    reviewedRunId: row.reviewed_run_id,
    action: row.action,
    state: row.state,
    feedback: row.feedback,
    revisionRunId: row.revision_run_id,
    followUpWorkItemId: row.follow_up_work_item_id,
    sourceUri: row.source_uri,
    error: row.error,
    version: row.version,
    actorType: row.actor_type,
    actorId: row.actor_id,
    codexThreadId: row.codex_thread_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createWorkReviewActionService({ db, workItems, workContext, workReview, workRunLauncher }) {
  const findAction = db.prepare("SELECT * FROM work_item_review_actions WHERE id=?");
  const findByReview = db.prepare("SELECT * FROM work_item_review_actions WHERE review_submission_id=?");
  const findIdempotency = db.prepare("SELECT * FROM work_review_action_idempotency WHERE operation=? AND idempotency_key=?");
  const insertIdempotency = db.prepare("INSERT INTO work_review_action_idempotency VALUES (?,?,?,?,?)");
  const insertAction = db.prepare(`INSERT INTO work_item_review_actions
    (id,review_submission_id,work_item_id,reviewed_run_id,action,state,feedback,revision_run_id,follow_up_work_item_id,source_uri,error,version,actor_type,actor_id,codex_thread_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const updateAction = db.prepare(`UPDATE work_item_review_actions SET state=?,revision_run_id=?,follow_up_work_item_id=?,error=?,version=version+1,updated_at=? WHERE id=? AND version=?`);
  const insertAudit = db.prepare(`INSERT INTO work_item_review_action_audit
    (id,review_action_id,action,actor_type,actor_id,codex_thread_id,before_version,after_version,before_json,after_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const listAudit = db.prepare("SELECT * FROM work_item_review_action_audit WHERE review_action_id=? ORDER BY rowid");

  function audit(event, actor, before, after) {
    insertAudit.run(randomUUID(), after?.id || before.id, event, actor.actorType, actor.actorId, actor.threadId,
      before?.version ?? null, after?.version ?? null, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, now());
  }

  function normalizedRequest(reviewId, input, item) {
    if (!ACTIONS.includes(input.action)) throw new WorkItemError(400, "无效的验收动作", "invalid_review_action");
    const feedback = String(input.feedback || "").trim().slice(0, 4_000);
    if (input.action === "request_changes" && !feedback) throw new WorkItemError(400, "退回修改必须填写验收意见", "review_feedback_required");
    return {
      reviewId,
      action: input.action,
      expectedReviewVersion: expectedVersion(input.expectedReviewVersion, "expectedReviewVersion"),
      expectedWorkItemVersion: expectedVersion(input.expectedWorkItemVersion, "expectedWorkItemVersion"),
      feedback,
      objective: String(input.objective || "").trim().slice(0, 10_000),
      followUp: input.action === "accept_with_follow_up" ? normalizeFollowUp(input.followUp, item) : null,
    };
  }

  function validate(reviewId, input, actorInput) {
    const actor = attribution(actorInput);
    const review = workReview.get(reviewId);
    if (!review) throw new WorkItemError(404, "验收提交不存在", "review_submission_not_found");
    const item = workItems.get(review.workItemId);
    const run = workItems.getRun(review.runId);
    const request = normalizedRequest(reviewId, input, item);
    if (review.version !== request.expectedReviewVersion || item.version !== request.expectedWorkItemVersion) {
      throw new WorkItemError(409, "Review 或 Work Item 已被其他操作修改，请重新读取", "version_conflict");
    }
    if (item.status !== "in_review" || run.status !== "completed") throw new WorkItemError(409, "只有待验收的已完成 Run 可以执行验收动作", "review_not_pending");
    if (workReview.list(item.id).at(-1)?.id !== review.id) throw new WorkItemError(409, "只能处理当前最新的验收提交", "review_is_not_latest");
    return { actor, review, item, run, request };
  }

  function idempotency(operation, key, request) {
    if (!key || !String(key).trim()) throw new WorkItemError(400, "必须提供 idempotencyKey", "missing_idempotency_key");
    const normalizedKey = String(key).trim().slice(0, 200);
    const hash = requestHash(request);
    const existing = findIdempotency.get(operation, normalizedKey);
    if (existing) {
      if (existing.request_hash !== hash) throw new WorkItemError(409, "相同幂等键对应了不同请求", "idempotency_conflict");
      return { replayed: true, entityId: existing.entity_id };
    }
    return { replayed: false, normalizedKey, hash };
  }

  function insert(review, request, actor, state, extras = {}) {
    const id = randomUUID();
    const createdAt = now();
    insertAction.run(id, review.id, review.workItemId, review.runId, request.action, state, request.feedback,
      extras.revisionRunId || null, extras.followUpWorkItemId || null, review.sourceUri, extras.error || null,
      1, actor.actorType, actor.actorId, actor.threadId, createdAt, createdAt);
    const action = mapAction(findAction.get(id));
    audit("create", actor, null, action);
    return action;
  }

  function recordState(id, expected, state, extras, actorInput) {
    if (!STATES.includes(state)) throw new WorkItemError(400, "无效的验收动作状态", "invalid_review_action_state");
    const actor = actorInput.actorType === "user" ? attribution(actorInput) : {
      actorType: "system",
      actorId: String(actorInput.actorId || "review-action-service").slice(0, 200),
      threadId: actorInput.threadId || null,
    };
    return transaction(db, () => {
      const row = findAction.get(id);
      if (!row) throw new WorkItemError(404, "验收动作不存在", "review_action_not_found");
      const current = mapAction(row);
      if (current.version !== expected) throw new WorkItemError(409, "验收动作已被其他操作修改", "version_conflict");
      const result = updateAction.run(state, extras.revisionRunId ?? current.revisionRunId, extras.followUpWorkItemId ?? current.followUpWorkItemId,
        extras.error ? String(extras.error).slice(0, 4_000) : null, now(), id, expected);
      if (Number(result.changes) !== 1) throw new WorkItemError(409, "验收动作已被其他操作修改", "version_conflict");
      const updated = mapAction(findAction.get(id));
      audit(`state_${state}`, actor, current, updated);
      return updated;
    });
  }

  async function apply(reviewId, input, actorInput) {
    const preliminaryReview = workReview.get(reviewId);
    if (!preliminaryReview) throw new WorkItemError(404, "验收提交不存在", "review_submission_not_found");
    const preliminaryItem = workItems.get(preliminaryReview.workItemId);
    const preliminaryRequest = normalizedRequest(reviewId, input, preliminaryItem);
    const operation = `review_action.apply:${reviewId}`;
    const replay = idempotency(operation, input.idempotencyKey, preliminaryRequest);
    const replayedAction = replay.replayed ? mapAction(findAction.get(replay.entityId)) : null;
    if (replayedAction && replayedAction.state !== "applying") return response(replayedAction, true);

    const prepared = replayedAction ? {
      action: replayedAction,
      actor: attribution(actorInput),
      review: preliminaryReview,
      run: workItems.getRun(preliminaryReview.runId),
      request: preliminaryRequest,
      workItem: preliminaryItem,
      followUpWorkItem: null,
      replayed: true,
    } : transaction(db, () => {
      const { actor, review, item, run, request } = validate(reviewId, input, actorInput);
      if (findByReview.get(reviewId)) throw new WorkItemError(409, "该验收提交已经处理", "review_already_resolved");

      let action;
      let workItem = item;
      let followUpWorkItem = null;
      if (request.action === "approve") {
        workItem = workItems.update(item.id, item.version, { status: "done" }, actor);
        action = insert(review, request, actor, "applied");
      } else if (request.action === "accept_with_follow_up") {
        followUpWorkItem = workItems.create(request.followUp, actor, { idempotencyKey: `review-action:${reviewId}:${input.idempotencyKey}:follow-up` });
        workContext.createRelation(followUpWorkItem.id, {
          expectedVersion: followUpWorkItem.version,
          targetWorkItemId: item.id,
          relationType: "parent",
        }, actor, `review-action:${reviewId}:${input.idempotencyKey}:relation`);
        followUpWorkItem = workItems.get(followUpWorkItem.id);
        workItem = workItems.update(item.id, item.version, { status: "done" }, actor);
        action = insert(review, request, actor, "applied", { followUpWorkItemId: followUpWorkItem.id });
      } else {
        workItem = workItems.update(item.id, item.version, {
          status: "ready",
          nextAction: `根据验收反馈修改：${request.feedback}`.slice(0, 2_000),
        }, actor);
        workContext.createEvidence(item.id, {
          expectedVersion: workItem.version,
          runId: run.id,
          kind: "review_feedback",
          label: "验收退回意见",
          uri: review.sourceUri,
          summary: request.feedback,
        }, actor, `review-action:${reviewId}:${input.idempotencyKey}:evidence`);
        workItem = workItems.get(item.id);
        action = insert(review, request, actor, "applying");
      }
      insertIdempotency.run(operation, replay.normalizedKey, replay.hash, action.id, now());
      return { action, actor, review, run, request, workItem, followUpWorkItem, replayed: false };
    });

    if (prepared.request.action !== "request_changes") return response(prepared.action, false);

    try {
      const launched = await workRunLauncher.start(prepared.workItem.id, {
        idempotencyKey: `review-action:${prepared.action.id}:revision-run`,
        expectedVersion: prepared.workItem.version,
        mode: prepared.run.mode,
        objective: prepared.request.objective || `根据验收反馈完成修改：${prepared.request.feedback}`,
        expectedOutput: "修改结果、验证证据、剩余风险与建议下一步",
        threadStrategy: "continue",
      }, prepared.actor);
      const systemActor = { actorType: "system", actorId: "review-action-service", threadId: launched.run.codexThreadId };
      const action = transaction(db, () => {
        const updatedAction = recordState(prepared.action.id, prepared.action.version, "applied", { revisionRunId: launched.run.id }, systemActor);
        const currentItem = workItems.get(prepared.workItem.id);
        if (currentItem.status === "ready" && launched.run.status === "running") {
          workItems.update(currentItem.id, currentItem.version, { status: "active" }, systemActor);
        }
        return updatedAction;
      });
      return response(action, prepared.replayed);
    } catch (error) {
      const revisionRun = error?.details?.run || workItems.listRuns(prepared.workItem.id)
        .filter((candidate) => candidate.id !== prepared.run.id && candidate.createdAt >= prepared.action.createdAt).at(-1) || null;
      const uncertain = error?.code === "codex_launch_uncertain" || revisionRun?.launchState === "uncertain";
      const action = recordState(prepared.action.id, prepared.action.version, uncertain ? "uncertain" : "failed", {
        revisionRunId: revisionRun?.id || null,
        error: error instanceof Error ? error.message : String(error),
      }, { actorType: "system", actorId: "review-action-service", threadId: revisionRun?.codexThreadId || null });
      const wrapped = new WorkItemError(502, uncertain
        ? "退回意见已保存，但修订 Run 的启动结果不确定；请检查绑定 task，勿自动重试"
        : "退回意见已保存，但修订 Run 启动失败；任务保持 ready，可重新发起执行",
      uncertain ? "review_revision_uncertain" : "review_revision_failed");
      wrapped.details = { reviewAction: action, revisionRun: revisionRun || null };
      throw wrapped;
    }
  }

  function response(action, replayed) {
    return {
      reviewAction: action,
      workItem: workItems.get(action.workItemId),
      reviewedRun: workItems.getRun(action.reviewedRunId),
      revisionRun: action.revisionRunId ? workItems.getRun(action.revisionRunId) : null,
      followUpWorkItem: action.followUpWorkItemId ? workItems.get(action.followUpWorkItemId) : null,
      replayed,
    };
  }

  return {
    apply,
    getByReview(reviewId) { const row = findByReview.get(reviewId); return row ? mapAction(row) : null; },
    listAudit(id) {
      if (!findAction.get(id)) throw new WorkItemError(404, "验收动作不存在", "review_action_not_found");
      return listAudit.all(id).map((row) => ({
        id: row.id,
        reviewActionId: row.review_action_id,
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
  };
}
