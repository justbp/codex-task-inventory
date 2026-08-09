import { randomUUID } from "node:crypto";
import { WorkItemError } from "./work-items.mjs";

const POLICY_ID = "default";
const MODES = ["warn", "block"];
let savepointSequence = 0;

function now() {
  return new Date().toISOString();
}

function transaction(db, operation) {
  const savepoint = `wip_policy_${++savepointSequence}`;
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

function actor(input = {}) {
  const actorType = input.actorType || "user";
  if (!["user", "codex", "system"].includes(actorType)) throw new WorkItemError(400, "无效的 actor type", "invalid_actor_type");
  const actorId = String(input.actorId || (actorType === "user" ? "local-user" : actorType)).trim().slice(0, 200);
  const threadId = input.threadId ? String(input.threadId).trim().slice(0, 200) : null;
  if (actorType === "codex" && !threadId) throw new WorkItemError(400, "Codex 写操作必须提供来源 thread ID", "missing_thread_id");
  return { actorType, actorId, threadId };
}

function mapPolicy(row) {
  return {
    id: row.id,
    mainlineLimit: row.mainline_limit,
    backgroundRunLimit: row.background_run_limit,
    reviewLimit: row.review_limit,
    enforcement: row.enforcement,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

function mapAudit(row) {
  return {
    id: row.id,
    action: row.action,
    actorType: row.actor_type,
    actorId: row.actor_id,
    codexThreadId: row.codex_thread_id,
    beforeVersion: row.before_version,
    afterVersion: row.after_version,
    before: row.before_json ? JSON.parse(row.before_json) : null,
    after: row.after_json ? JSON.parse(row.after_json) : null,
    createdAt: row.created_at,
  };
}

export function initWipPolicySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wip_policy (
      id TEXT PRIMARY KEY CHECK (id = 'default'),
      mainline_limit INTEGER NOT NULL DEFAULT 1 CHECK (mainline_limit BETWEEN 0 AND 99),
      background_run_limit INTEGER NOT NULL DEFAULT 2 CHECK (background_run_limit BETWEEN 0 AND 99),
      review_limit INTEGER NOT NULL DEFAULT 2 CHECK (review_limit BETWEEN 0 AND 99),
      enforcement TEXT NOT NULL DEFAULT 'warn' CHECK (enforcement IN ('warn','block')),
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wip_policy_audit_events (
      id TEXT PRIMARY KEY,
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
  `);
  db.prepare(`INSERT OR IGNORE INTO wip_policy
    (id,mainline_limit,background_run_limit,review_limit,enforcement,version,updated_at)
    VALUES ('default',1,2,2,'warn',1,?)`).run(now());
}

export function createWipPolicyRepository(db) {
  const find = db.prepare("SELECT * FROM wip_policy WHERE id=?");
  const update = db.prepare(`UPDATE wip_policy SET
    mainline_limit=?,background_run_limit=?,review_limit=?,enforcement=?,version=?,updated_at=?
    WHERE id=? AND version=?`);
  const insertAudit = db.prepare(`INSERT INTO wip_policy_audit_events
    (id,action,actor_type,actor_id,codex_thread_id,before_version,after_version,before_json,after_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const listAudit = db.prepare("SELECT * FROM wip_policy_audit_events ORDER BY rowid");
  const countMainline = db.prepare("SELECT COUNT(*) AS count FROM work_items WHERE today_focus=1 AND status NOT IN ('done','canceled')");
  const countBackground = db.prepare("SELECT COUNT(*) AS count FROM work_item_runs WHERE status IN ('queued','running')");
  const countReview = db.prepare("SELECT COUNT(*) AS count FROM work_items WHERE status='in_review'");

  function get() {
    return mapPolicy(find.get(POLICY_ID));
  }

  function counts() {
    return {
      mainline: Number(countMainline.get().count),
      backgroundRuns: Number(countBackground.get().count),
      review: Number(countReview.get().count),
    };
  }

  function snapshot() {
    const policy = get();
    const current = counts();
    return {
      counts: current,
      lanes: {
        mainline: { count: current.mainline, limit: policy.mainlineLimit, atLimit: current.mainline >= policy.mainlineLimit, exceeded: current.mainline > policy.mainlineLimit },
        backgroundRuns: { count: current.backgroundRuns, limit: policy.backgroundRunLimit, atLimit: current.backgroundRuns >= policy.backgroundRunLimit, exceeded: current.backgroundRuns > policy.backgroundRunLimit },
        review: { count: current.review, limit: policy.reviewLimit, atLimit: current.review >= policy.reviewLimit, exceeded: current.review > policy.reviewLimit },
      },
    };
  }

  function normalizeLimit(value, name, fallback) {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < 0 || value > 99) throw new WorkItemError(400, `${name} 必须是 0 到 99 的整数`, "invalid_wip_limit");
    return value;
  }

  function patch(expectedVersion, change, attributionInput = {}) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new WorkItemError(400, "必须提供有效的 expectedVersion", "invalid_expected_version");
    const attribution = actor(attributionInput);
    if (attribution.actorType !== "user") throw new WorkItemError(403, "WIP 策略只能由用户修改", "user_confirmation_required");
    const allowed = ["mainlineLimit", "backgroundRunLimit", "reviewLimit", "enforcement"];
    const unknown = Object.keys(change).filter((key) => !allowed.includes(key));
    if (unknown.length) throw new WorkItemError(400, `不支持字段：${unknown.join(", ")}`, "invalid_wip_policy_field");
    return transaction(db, () => {
      const current = get();
      if (current.version !== expectedVersion) throw new WorkItemError(409, "WIP 策略已被其他操作修改，请重新读取", "version_conflict");
      const next = {
        ...current,
        mainlineLimit: normalizeLimit(change.mainlineLimit, "今日主线上限", current.mainlineLimit),
        backgroundRunLimit: normalizeLimit(change.backgroundRunLimit, "后台 Run 上限", current.backgroundRunLimit),
        reviewLimit: normalizeLimit(change.reviewLimit, "待验收上限", current.reviewLimit),
        enforcement: change.enforcement === undefined ? current.enforcement : change.enforcement,
        version: current.version + 1,
      };
      if (!MODES.includes(next.enforcement)) throw new WorkItemError(400, "WIP 执行方式只能是 warn 或 block", "invalid_wip_enforcement");
      const updatedAt = now();
      const result = update.run(next.mainlineLimit, next.backgroundRunLimit, next.reviewLimit, next.enforcement, next.version, updatedAt, POLICY_ID, expectedVersion);
      if (Number(result.changes) !== 1) throw new WorkItemError(409, "WIP 策略已被其他操作修改，请重新读取", "version_conflict");
      const updated = get();
      insertAudit.run(randomUUID(), "update", attribution.actorType, attribution.actorId, attribution.threadId,
        current.version, updated.version, JSON.stringify(current), JSON.stringify(updated), updatedAt);
      return updated;
    });
  }

  function decision(violations) {
    const policy = get();
    const warnings = violations.map((item) => ({ ...item, enforcement: policy.enforcement }));
    if (warnings.length && policy.enforcement === "block") {
      const error = new WorkItemError(409, warnings.map((item) => item.message).join("；"), "wip_limit_exceeded");
      error.details = { warnings, policy, snapshot: snapshot() };
      throw error;
    }
    return { warnings, policy, snapshot: snapshot() };
  }

  function checkMainlineAddition() {
    const policy = get();
    const current = counts();
    const nextCount = current.mainline + 1;
    return decision(nextCount > policy.mainlineLimit ? [{ lane: "mainline", count: current.mainline, attemptedCount: nextCount, limit: policy.mainlineLimit, message: `今日主线将达到 ${nextCount} 项，超过上限 ${policy.mainlineLimit} 项` }] : []);
  }

  function checkRunStart() {
    const policy = get();
    const current = counts();
    const violations = [];
    if (current.backgroundRuns + 1 > policy.backgroundRunLimit) violations.push({ lane: "backgroundRuns", count: current.backgroundRuns, attemptedCount: current.backgroundRuns + 1, limit: policy.backgroundRunLimit, message: `后台 Run 将达到 ${current.backgroundRuns + 1} 个，超过上限 ${policy.backgroundRunLimit} 个` });
    if (current.review >= policy.reviewLimit) violations.push({ lane: "review", count: current.review, attemptedCount: current.review, limit: policy.reviewLimit, message: `待验收已有 ${current.review} 项，已达到上限 ${policy.reviewLimit} 项` });
    return decision(violations);
  }

  return { get, snapshot, patch, listAudit: () => listAudit.all().map(mapAudit), checkMainlineAddition, checkRunStart };
}
