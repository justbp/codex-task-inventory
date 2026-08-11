import assert from "node:assert/strict";
import test from "node:test";
import { buildSnapshot, run } from "../skills/manage-codex-board/scripts/boardctl.mjs";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

test("builds a compact bounded management snapshot", () => {
  const threads = Array.from({ length: 20 }, (_, index) => ({
    id: `task-${index}`,
    title: `Task ${index}`,
    kind: "codex",
    lane: index % 2 ? "review" : "in_progress",
    runtimeStatus: index % 2 ? "idle" : "active",
    project: "demo",
    cwd: "/tmp/demo",
    updatedAt: `2026-08-10T00:${String(index).padStart(2, "0")}:00.000Z`,
    lastProgress: "x".repeat(500),
  }));
  const snapshot = buildSnapshot(threads, 3, new Date("2026-08-10T01:00:00.000Z"));
  assert.equal(snapshot.counts.total, 20);
  assert.equal(snapshot.active.length, 3);
  assert.equal(snapshot.review.length, 3);
  assert.equal(snapshot.active[0].progress.length, 180);
  assert.match(snapshot.attentionToken, /^[a-f0-9]{16}$/);
});

test("attention token changes only when attention-relevant state changes", () => {
  const thread = {
    id: "task-1",
    title: "Active task",
    kind: "codex",
    lane: "in_progress",
    runtimeStatus: "active",
    priority: "high",
    project: "demo",
    cwd: "/tmp/demo",
    activeStartedAt: "2026-08-10T08:00:00.000Z",
    lastProgressAt: "2026-08-10T08:30:00.000Z",
    updatedAt: "2026-08-10T08:30:00.000Z",
    deepLink: "codex://threads/task-1",
  };
  const fresh = buildSnapshot([thread], 12, new Date("2026-08-10T09:00:00.000Z"));
  const stillFresh = buildSnapshot([{ ...thread, lastProgressAt: "2026-08-10T08:45:00.000Z" }], 12, new Date("2026-08-10T09:30:00.000Z"));
  const stalled = buildSnapshot([thread], 12, new Date("2026-08-10T10:00:00.000Z"));

  assert.equal(fresh.attentionToken, stillFresh.attentionToken);
  assert.notEqual(fresh.attentionToken, stalled.attentionToken);
  assert.equal(fresh.active[0].priority, "high");
  assert.equal(fresh.active[0].activeStartedAt, "2026-08-10T08:00:00.000Z");
  assert.equal(fresh.active[0].deepLink, "codex://threads/task-1");
});

test("dispatch preserves user text and starts the created upcoming item", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/api/items")) return jsonResponse({ item: { id: "item-1" } }, 201);
    return jsonResponse({ threadId: "thread-1", deepLink: "codex://threads/thread-1" });
  };
  const result = await run([
    "dispatch", "--title", "修复登录", "--note", "只补测试", "--project", "demo", "--cwd", "/tmp/demo",
  ], { fetchImpl, baseUrl: "http://board.test" });
  assert.equal(result.launched.threadId, "thread-1");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    title: "修复登录", note: "只补测试", project: "demo", cwd: "/tmp/demo", lane: "upcoming",
  });
  assert.equal(calls[1].url, "http://board.test/api/items/item-1/start");
});

test("publishes disposable attention advice without changing tasks", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({ advice: JSON.parse(options.body) });
  };
  const result = await run([
    "publish-advice", "--attention-token", "token-1", "--headline", "验收两个结果", "--focus", "先检查草稿 PR",
    "--background", "无运行任务", "--next-check", "验收后", "--primary-task-id", "task-1",
  ], { fetchImpl, baseUrl: "http://board.test" });
  assert.equal(calls[0].url, "http://board.test/api/attention-advice");
  assert.equal(calls[0].options.method, "PUT");
  assert.equal(result.advice.headline, "验收两个结果");
  assert.equal(result.advice.primaryTaskId, "task-1");
});
