import { randomUUID } from "node:crypto";
import { WorkItemError } from "./work-items.mjs";

let savepointSequence = 0;

function transaction(db, operation) {
  const savepoint = `work_review_${++savepointSequence}`;
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

function sectionKey(title) {
  const normalized = title.replace(/[：:]/g, "").trim();
  return ({
    已完成: "completedSummary",
    验证结果: "verificationSummary",
    风险: "risks",
    需要用户决定: "needsDecision",
    下一步: "suggestedNextAction",
  })[normalized] || null;
}

export function parseReviewReport(text = "") {
  const result = { completedSummary: "", verificationSummary: "", risks: "", needsDecision: "", suggestedNextAction: "" };
  let currentKey = null;
  for (const line of String(text).split("\n")) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/);
    const key = heading ? sectionKey(heading[1]) : null;
    if (key) { currentKey = key; continue; }
    if (currentKey) result[currentKey] = `${result[currentKey]}${result[currentKey] ? "\n" : ""}${line}`.trim().slice(0, 2_000);
  }
  if (!result.completedSummary) result.completedSummary = String(text).trim().slice(0, 2_000) || "Codex 已结束本次 Run，但未提供结构化完成摘要。";
  return result;
}

export function initWorkReviewSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_item_review_submissions (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_items(id),
      run_id TEXT NOT NULL UNIQUE REFERENCES work_item_runs(id),
      work_item_version INTEGER NOT NULL,
      completed_summary TEXT NOT NULL,
      verification_summary TEXT NOT NULL DEFAULT '',
      risks TEXT NOT NULL DEFAULT '',
      needs_decision TEXT NOT NULL DEFAULT '',
      suggested_next_action TEXT NOT NULL DEFAULT '',
      source_uri TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      codex_thread_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_review_submissions_work_item ON work_item_review_submissions(work_item_id, created_at);
  `);
}

function mapReview(row) {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    runId: row.run_id,
    workItemVersion: row.work_item_version,
    completedSummary: row.completed_summary,
    verificationSummary: row.verification_summary,
    risks: row.risks,
    needsDecision: row.needs_decision,
    suggestedNextAction: row.suggested_next_action,
    sourceUri: row.source_uri,
    version: row.version,
    actorType: row.actor_type,
    actorId: row.actor_id,
    codexThreadId: row.codex_thread_id,
    createdAt: row.created_at,
  };
}

export function createWorkReviewRepository(db, workItems) {
  const findReview = db.prepare("SELECT * FROM work_item_review_submissions WHERE id=?");
  const findByRun = db.prepare("SELECT * FROM work_item_review_submissions WHERE run_id=?");
  const listByWorkItem = db.prepare("SELECT * FROM work_item_review_submissions WHERE work_item_id=? ORDER BY rowid");
  const insertReview = db.prepare(`INSERT INTO work_item_review_submissions
    (id,work_item_id,run_id,work_item_version,completed_summary,verification_summary,risks,needs_decision,suggested_next_action,source_uri,version,actor_type,actor_id,codex_thread_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  function processTurnCompleted(runId, event) {
    const run = workItems.getRun(runId);
    if (!run) throw new WorkItemError(404, "运行记录不存在", "run_not_found");
    if (run.codexThreadId !== event.threadId || run.codexTurnId !== event.turnId) {
      throw new WorkItemError(409, "完成事件与 Run 绑定的 thread/turn 不匹配", "terminal_turn_mismatch");
    }
    const eventKey = `${event.threadId}:${event.turnId}:${event.status}`;
    const attribution = { actorType: "system", actorId: "codex-turn-listener", threadId: event.threadId };
    return transaction(db, () => {
      const terminal = workItems.recordTerminal(runId, {
        eventKey,
        turnId: event.turnId,
        status: event.status,
        error: event.error,
        completedAt: event.completedAt,
      }, attribution);
      let review = findByRun.get(runId);
      let workItem = workItems.get(run.workItemId);
      if (!terminal.replayed && event.status === "completed") {
        const report = parseReviewReport(event.finalMessage);
        const id = randomUUID();
        const createdAt = event.completedAt || new Date().toISOString();
        insertReview.run(
          id, run.workItemId, runId, workItem.version, report.completedSummary, report.verificationSummary,
          report.risks, report.needsDecision, report.suggestedNextAction,
          `codex://threads/${event.threadId}?turn=${event.turnId}`, 1,
          attribution.actorType, attribution.actorId, attribution.threadId, createdAt,
        );
        review = findByRun.get(runId);
        if (["ready", "active"].includes(workItem.status)) {
          workItem = workItems.update(workItem.id, workItem.version, { status: "in_review" }, attribution);
        }
      }
      return {
        run: terminal.run,
        review: review ? mapReview(review) : null,
        workItem,
        replayed: terminal.replayed,
      };
    });
  }

  function reconcileMonitoredThreads(threads = []) {
    const synchronized = [];
    for (const thread of threads) {
      const candidates = Array.isArray(thread.terminalTurns) && thread.terminalTurns.length
        ? thread.terminalTurns
        : [
          thread.lastCompletedTurnId ? { turnId: thread.lastCompletedTurnId, status: "completed", completedAt: thread.lastCompletedAt, finalMessage: thread.lastProgress || "" } : null,
          thread.lastInterruptedTurnId ? { turnId: thread.lastInterruptedTurnId, status: "interrupted", completedAt: thread.lastInterruptedAt, error: thread.lastError || "" } : null,
        ].filter(Boolean);
      for (const event of candidates) {
        const run = workItems.getRunByTurn(thread.id, event.turnId);
        if (!run || run.terminalEventKey) continue;
        synchronized.push(processTurnCompleted(run.id, { ...event, threadId: thread.id }));
      }
    }
    return synchronized;
  }

  return {
    processTurnCompleted,
    reconcileMonitoredThreads,
    get(id) { const row = findReview.get(id); return row ? mapReview(row) : null; },
    getByRun(runId) { const row = findByRun.get(runId); return row ? mapReview(row) : null; },
    list(workItemId) {
      if (!workItems.get(workItemId)) throw new WorkItemError(404, "工作任务不存在", "work_item_not_found");
      return listByWorkItem.all(workItemId).map(mapReview);
    },
  };
}
