import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createWorkItemRepository, initWorkItemSchema } from "../server/work-items.mjs";
import { createWipPolicyRepository, initWipPolicySchema } from "../server/wip-policy.mjs";

test("keeps WIP policy versioned, attributable, and separate across Work and Run counts", () => {
  const db = new DatabaseSync(":memory:");
  initWorkItemSchema(db);
  initWipPolicySchema(db);
  const workItems = createWorkItemRepository(db);
  const policy = createWipPolicyRepository(db);

  assert.deepEqual(policy.get(), {
    id: "default", mainlineLimit: 1, backgroundRunLimit: 2, reviewLimit: 2,
    enforcement: "warn", version: 1, updatedAt: policy.get().updatedAt,
  });

  workItems.create({ title: "主线任务", status: "ready", todayFocus: true });
  workItems.create({ title: "待验收任务", status: "in_review" });
  const runningItem = workItems.create({ title: "后台任务", status: "active" });
  workItems.createRun(runningItem.id, { status: "queued", expectedWorkItemVersion: runningItem.version }, {}, "wip-unit-run");

  assert.deepEqual(policy.snapshot().counts, { mainline: 1, backgroundRuns: 1, review: 1 });
  assert.equal(policy.checkMainlineAddition().warnings[0].lane, "mainline");

  const blocked = policy.patch(1, { mainlineLimit: 1, backgroundRunLimit: 1, reviewLimit: 1, enforcement: "block" }, { actorType: "user", actorId: "wangfei" });
  assert.equal(blocked.version, 2);
  assert.throws(() => policy.checkMainlineAddition(), (error) => error.code === "wip_limit_exceeded" && error.details.warnings[0].lane === "mainline");
  assert.throws(() => policy.checkRunStart(), (error) => error.code === "wip_limit_exceeded" && error.details.warnings.some((warning) => warning.lane === "backgroundRuns") && error.details.warnings.some((warning) => warning.lane === "review"));
  assert.throws(() => policy.patch(1, { enforcement: "warn" }, { actorType: "user", actorId: "wangfei" }), (error) => error.code === "version_conflict");
  assert.throws(() => policy.patch(2, { enforcement: "warn" }, { actorType: "codex", actorId: "manager", threadId: "manager-thread" }), (error) => error.code === "user_confirmation_required");

  assert.deepEqual(policy.listAudit().map((event) => [event.action, event.actorType, event.actorId, event.beforeVersion, event.afterVersion]), [
    ["update", "user", "wangfei", 1, 2],
  ]);
  db.close();
});
