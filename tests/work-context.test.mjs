import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initMetadata } from "../server/index.mjs";
import { createWorkContextRepository, initWorkContextSchema } from "../server/work-context.mjs";
import { createWorkItemRepository, initWorkItemSchema } from "../server/work-items.mjs";

function withContext(run) {
  const sandbox = mkdtempSync(join(tmpdir(), "codex-work-context-"));
  const db = new DatabaseSync(join(sandbox, "monitor.db"));
  try {
    initMetadata(db);
    initWorkItemSchema(db);
    initWorkContextSchema(db);
    const workItems = createWorkItemRepository(db);
    return run({ db, workItems, context: createWorkContextRepository(db, workItems) });
  } finally {
    db.close();
    rmSync(sandbox, { recursive: true, force: true });
  }
}

const user = { actorType: "user", actorId: "wangfei" };

function readyItem(workItems, key = "ready-item") {
  return workItems.create({
    title: "实现可恢复上下文",
    goal: "让新对话不读取旧对话全文也能继续工作",
    nextAction: "实现并验证 Context Envelope",
    acceptanceCriteria: ["新 Run 保存上下文快照", "旧快照不被后续修改覆盖"],
    scope: { allowed: "修改任务上下文模块和测试", excluded: "不得修改生产数据" },
    stopConditions: ["需要扩大权限"],
    constraints: ["只保存摘要和证据引用"],
    status: "ready",
    stage: "execute",
  }, user, { idempotencyKey: key });
}

test("builds a minimal versioned envelope and freezes it on the Run", () => withContext(({ workItems, context }) => {
  let item = readyItem(workItems);
  const target = workItems.create({ title: "依赖任务" }, user, { idempotencyKey: "relation-target" });

  context.createDecision(item.id, { expectedVersion: item.version, decision: "使用结构化快照", reason: "避免依赖聊天记忆" }, user, "decision-one");
  item = workItems.get(item.id);
  context.createEvidence(item.id, { expectedVersion: item.version, kind: "test", label: "测试报告", uri: "test://work-context", summary: "只保存简短摘要" }, user, "evidence-one");
  item = workItems.get(item.id);
  context.createRelation(item.id, { expectedVersion: item.version, relationType: "blocked_by", targetWorkItemId: target.id }, user, "relation-one");
  item = workItems.get(item.id);
  context.createRecoveryPoint(item.id, {
    expectedVersion: item.version,
    currentConclusion: "数据模型已经确定",
    completed: ["Work Item 字段"],
    unresolved: ["API 集成"],
    nextAction: "继续实现 API 集成",
    resourceRefs: ["test://work-context"],
    status: "ready",
  }, user, "recovery-one");
  item = workItems.get(item.id);

  const envelope = context.buildEnvelope(item.id, { expectedVersion: item.version, mode: "implementation", objective: "继续 M2" });
  assert.equal(envelope.workItem.version, item.version);
  assert.equal(envelope.decisions[0].decision, "使用结构化快照");
  assert.equal(envelope.recoveryPoint.nextAction, "继续实现 API 集成");
  assert.deepEqual(envelope.relations.blockedBy, [target.id]);
  assert.equal(envelope.evidenceRefs[0].uri, "test://work-context");
  assert.equal("content" in envelope.evidenceRefs[0], false, "raw evidence must not be copied into the envelope");

  const run = workItems.createRun(item.id, {
    objective: "继续 M2",
    mode: "implementation",
    expectedWorkItemVersion: item.version,
    contextEnvelope: envelope,
    contextWorkItemVersion: item.version,
  }, user, "context-run");
  assert.throws(
    () => workItems.updateRun(run.id, run.version, { mode: "explore" }, user),
    (error) => error.code === "context_snapshot_immutable",
  );
  const oldGoal = run.contextEnvelope.workItem.goal;
  workItems.update(item.id, item.version, { goal: "修改后的目标" }, user);
  const storedRun = workItems.getRun(run.id);
  assert.equal(storedRun.contextWorkItemVersion, item.version);
  assert.equal(storedRun.contextEnvelope.workItem.goal, oldGoal);
  assert.notEqual(workItems.get(item.id).goal, oldGoal);
}));

test("blocks implementation when the task is immature but allows read-only exploration", () => withContext(({ workItems, context }) => {
  const item = workItems.create({ title: "模糊需求" }, user, { idempotencyKey: "immature-item" });
  const check = context.readiness(item.id, "implementation");
  assert.equal(check.ready, false);
  assert.deepEqual(check.missing, ["goal", "nextAction", "acceptanceCriteria", "scope.allowed"]);
  assert.throws(
    () => context.buildEnvelope(item.id, { expectedVersion: item.version, mode: "implementation" }),
    (error) => error.code === "work_item_not_ready" && error.details.suggestedMode === "explore",
  );
  const envelope = context.buildEnvelope(item.id, { expectedVersion: item.version, mode: "explore" });
  assert.match(envelope.scope.allowed, /只读探索/);
  assert.match(envelope.scope.excluded, /不得修改/);
}));

test("requires a recovery point for a resumable pause and rejects stale context writes", () => withContext(({ workItems, context }) => {
  const item = readyItem(workItems, "pause-item");
  assert.throws(
    () => context.createRecoveryPoint(item.id, {
      expectedVersion: item.version,
      nextAction: "等待用户确认暂停",
      status: "parked",
    }, { actorType: "codex", actorId: "codex-agent", threadId: "thread-pause" }, "codex-pause"),
    (error) => error.code === "user_confirmation_required" && error.status === 403,
  );
  const recovery = context.createRecoveryPoint(item.id, {
    expectedVersion: item.version,
    currentConclusion: "已确认核心路径",
    completed: ["完成调研"],
    unresolved: ["尚未实现"],
    nextAction: "从核心路径开始实现",
    status: "parked",
  }, user, "pause-one");
  assert.equal(workItems.get(item.id).status, "parked");
  assert.equal(workItems.get(item.id).nextAction, "从核心路径开始实现");
  assert.equal(recovery.actorId, "wangfei");
  assert.throws(
    () => context.createDecision(item.id, { expectedVersion: item.version, decision: "过期决定" }, user, "stale-decision"),
    (error) => error.code === "version_conflict",
  );
  const envelope = context.buildEnvelope(item.id, { expectedVersion: workItems.get(item.id).version, mode: "implementation" });
  assert.equal(envelope.recoveryPoint.currentConclusion, "已确认核心路径");
}));

test("keeps context creation idempotent and rejects copied raw evidence", () => withContext(({ workItems, context }) => {
  const item = readyItem(workItems, "evidence-item");
  const input = { expectedVersion: item.version, label: "构建日志", uri: "artifact://build/1", summary: "构建通过" };
  const first = context.createEvidence(item.id, input, user, "evidence-idempotent");
  const repeated = context.createEvidence(item.id, input, user, "evidence-idempotent");
  assert.deepEqual(repeated, first);
  assert.equal(context.context(item.id).evidence.length, 1);
  assert.throws(
    () => context.createEvidence(item.id, { ...input, expectedVersion: workItems.get(item.id).version, summary: "x".repeat(2001) }, user, "raw-evidence"),
    (error) => error.code === "evidence_summary_too_large",
  );
}));
