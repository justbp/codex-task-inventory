import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initMetadata } from "../server/index.mjs";
import { createWorkItemRepository, initWorkItemSchema, migrateLegacyWork } from "../server/work-items.mjs";

function withRepository(run) {
  const sandbox = mkdtempSync(join(tmpdir(), "codex-work-items-"));
  const db = new DatabaseSync(join(sandbox, "monitor.db"));
  try {
    initMetadata(db);
    initWorkItemSchema(db);
    return run({ db, repository: createWorkItemRepository(db) });
  } finally {
    db.close();
    rmSync(sandbox, { recursive: true, force: true });
  }
}

test("keeps a work item independent from zero or many Codex runs", () => withRepository(({ repository }) => {
  const workItem = repository.create(
    { title: "建立任务模型", description: "先验证任务与对话分离", status: "ready", stage: "execute" },
    { actorType: "user", actorId: "wangfei" },
    { idempotencyKey: "create-work-item" },
  );
  assert.equal(workItem.version, 1);
  assert.equal(workItem.source, null);
  assert.deepEqual(repository.listRuns(workItem.id), []);

  const first = repository.createRun(workItem.id, {
    objective: "第一次只读调研",
    status: "running",
    codexThreadId: "thread-one",
    codexTurnId: "turn-one",
  }, { actorType: "user", actorId: "wangfei" }, "run-one");
  const second = repository.createRun(workItem.id, {
    objective: "第二次验证",
    status: "queued",
    codexThreadId: "thread-two",
  }, { actorType: "codex", actorId: "codex-agent", threadId: "manager-thread" }, "run-two");

  assert.notEqual(first.id, second.id);
  assert.equal(repository.list().length, 1);
  assert.deepEqual(repository.listRuns(workItem.id).map((run) => run.codexThreadId), ["thread-one", "thread-two"]);
}));

test("rejects stale versions and keeps an attributable audit trail", () => withRepository(({ repository }) => {
  const created = repository.create(
    { title: "并发更新测试" },
    { actorType: "user", actorId: "wangfei" },
    { idempotencyKey: "versioned-work-item" },
  );
  const updated = repository.update(created.id, created.version, { title: "已更新名称", status: "ready" }, {
    actorType: "codex", actorId: "codex-agent", threadId: "thread-audit",
  });
  assert.equal(updated.version, 2);
  assert.throws(
    () => repository.update(created.id, created.version, { title: "过期覆盖" }, { actorType: "user", actorId: "wangfei" }),
    (error) => error.code === "version_conflict" && error.status === 409,
  );
  assert.equal(repository.get(created.id).title, "已更新名称");

  const events = repository.listAudit("work_item", created.id);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => [event.action, event.actorType, event.actorId, event.codexThreadId, event.beforeVersion, event.afterVersion]), [
    ["create", "user", "wangfei", null, null, 1],
    ["update", "codex", "codex-agent", "thread-audit", 1, 2],
  ]);
}));

test("deduplicates run creation with an atomic idempotency record", () => withRepository(({ repository }) => {
  const workItem = repository.create({ title: "幂等测试" }, { actorType: "user", actorId: "wangfei" }, { idempotencyKey: "idempotent-work-item" });
  const request = { objective: "只创建一次", status: "queued", codexThreadId: "thread-idempotent" };
  const first = repository.createRun(workItem.id, request, { actorType: "user", actorId: "wangfei" }, "same-run-key");
  const repeated = repository.createRun(workItem.id, request, { actorType: "user", actorId: "wangfei" }, "same-run-key");
  assert.deepEqual(repeated, first);
  assert.equal(repository.listRuns(workItem.id).length, 1);
  assert.equal(repository.listAudit("run", first.id).length, 1);
  assert.throws(
    () => repository.createRun(workItem.id, { ...request, objective: "不同请求" }, { actorType: "user", actorId: "wangfei" }, "same-run-key"),
    (error) => error.code === "idempotency_conflict" && error.status === 409,
  );
}));

test("prevents Codex attribution from confirming a work item as done", () => withRepository(({ repository }) => {
  const workItem = repository.create({ title: "人工验收边界", status: "in_review" }, { actorType: "user", actorId: "wangfei" }, { idempotencyKey: "review-boundary" });
  assert.throws(
    () => repository.update(workItem.id, workItem.version, { status: "done" }, { actorType: "codex", actorId: "codex-agent", threadId: "thread-review" }),
    (error) => error.code === "codex_cannot_complete" && error.status === 403,
  );
  assert.equal(repository.get(workItem.id).status, "in_review");
}));

test("keeps today's mainline as a versioned user decision", () => withRepository(({ repository }) => {
  const created = repository.create(
    { title: "今日主线候选", status: "ready" },
    { actorType: "user", actorId: "wangfei" },
    { idempotencyKey: "today-focus-work-item" },
  );
  assert.equal(created.todayFocus, false);

  const focused = repository.update(created.id, created.version, { todayFocus: true }, { actorType: "user", actorId: "wangfei" });
  assert.equal(focused.todayFocus, true);
  assert.equal(focused.version, 2);
  assert.throws(
    () => repository.update(focused.id, focused.version, { todayFocus: false }, { actorType: "codex", actorId: "codex-agent", threadId: "manager-thread" }),
    (error) => error.code === "user_confirmation_required" && error.status === 403,
  );
  assert.equal(repository.get(created.id).todayFocus, true);
  assert.deepEqual(repository.listAudit("work_item", created.id).map((event) => [event.actorType, event.afterVersion]), [["user", 1], ["user", 2]]);
}));

test("maps legacy manual tasks and Codex metadata without duplicating a bound task", () => withRepository(({ db, repository }) => {
  db.prepare(`INSERT INTO manual_tasks
    (id,title,note,lane,project,cwd,tags,priority,sort_order,pinned,codex_thread_id,completed_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "manual-bound", "已启动手工任务", "保留目标", "upcoming", "demo", "/tmp/demo", "[\"legacy\"]", "high", 2, 1,
      "thread-bound", null, "2026-08-01T00:00:00.000Z", "2026-08-01T01:00:00.000Z",
    );
  db.prepare(`INSERT INTO manual_tasks
    (id,title,note,lane,project,cwd,tags,priority,sort_order,pinned,codex_thread_id,completed_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "manual-unbound", "未启动手工任务", "仍然独立", "inbox", "demo", null, "[]", "medium", 3, 0,
      null, null, "2026-08-01T00:00:00.000Z", "2026-08-01T01:00:00.000Z",
    );
  db.prepare(`INSERT INTO thread_metadata
    (thread_id,lane,project_override,tags,priority,sort_order,pinned,hidden,note,completed_at,last_seen_completion,last_seen_interruption,review_tracking_started_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "thread-bound", "upcoming", "demo", "[]", "high", 2, 0, 0, "bound metadata", null, null, null,
      "2026-08-01T00:00:00.000Z", "2026-08-01T01:00:00.000Z",
    );
  db.prepare(`INSERT INTO thread_metadata
    (thread_id,lane,project_override,tags,priority,sort_order,pinned,hidden,note,completed_at,last_seen_completion,last_seen_interruption,review_tracking_started_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "thread-standalone", "review", "demo", "[\"codex\"]", "medium", 4, 0, 0, "standalone metadata", null, null, null,
      "2026-08-01T00:00:00.000Z", "2026-08-01T01:00:00.000Z",
    );

  migrateLegacyWork(db, repository, [
    { id: "thread-bound", title: "已启动手工任务", runtimeStatus: "active", activeTurnId: "turn-bound", cwd: "/tmp/demo", project: "demo" },
    { id: "thread-standalone", title: "已有 Codex 任务", runtimeStatus: "idle", activeTurnId: null, cwd: "/tmp/demo", project: "demo" },
    { id: "thread-unseen", title: "尚无元数据的运行任务", runtimeStatus: "waiting", activeTurnId: "turn-unseen", cwd: "/tmp/demo", project: "demo" },
  ]);

  assert.equal(repository.list().length, 4);
  const bound = repository.getBySource("manual", "manual-bound");
  const unbound = repository.getBySource("manual", "manual-unbound");
  const standalone = repository.getBySource("codex", "thread-standalone");
  const unseen = repository.getBySource("codex", "thread-unseen");
  assert.equal(repository.listRuns(bound.id).length, 1);
  assert.equal(repository.listRuns(bound.id)[0].codexThreadId, "thread-bound");
  assert.equal(repository.listRuns(unbound.id).length, 0);
  assert.equal(repository.listRuns(standalone.id).length, 1);
  assert.equal(unseen.status, "active");
  assert.equal(repository.listRuns(unseen.id)[0].status, "waiting");
  assert.equal(repository.getBySource("codex", "thread-bound"), null, "bound manual task must not create a duplicate Codex work item");

  migrateLegacyWork(db, repository, []);
  assert.equal(repository.list().length, 4, "repeated migration must stay idempotent");
  assert.equal(repository.listRuns(bound.id).length, 1);
}));
