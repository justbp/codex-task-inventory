import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createTaskServer, findReviewTransitions } from "../server/index.mjs";

const sandbox = mkdtempSync(join(tmpdir(), "codex-task-monitor-"));
const dist = join(sandbox, "dist");
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, "index.html"), "<!doctype html><title>Codex monitor</title>");

const sample = {
  id: "019fc79b-3541-7853-a09a-6bcd9ced1388", title: "验证 Codex 监控", preview: "先验证数据源", cwd: "/tmp/project", project: "project",
  source: "vscode", createdAt: "2026-08-03T10:00:00.000Z", updatedAt: "2026-08-03T10:01:00.000Z", archived: false, pinned: false,
  deepLink: "codex://threads/019fc79b-3541-7853-a09a-6bcd9ced1388", runtimeStatus: "active", activeTurnId: "turn-1", activeStartedAt: "2026-08-03T10:01:00.000Z",
  lastCompletedAt: null, lastInterruptedAt: null, lastProgress: "正在验证", lastProgressAt: "2026-08-03T10:01:10.000Z", lastFileChangeAt: null, lastError: "",
  terminalTurns: [],
};
const monitoredThreads = [sample];
const launches = [];
const remoteNames = new Map();
const quotaReads = [];
const notifications = [];
const monitor = { list: () => monitoredThreads };
const quotaReader = {
  async read(options) {
    quotaReads.push(options);
    return {
      available: true, limitId: "codex", limitName: null, planType: "plus",
      primary: { usedPercent: 27, remainingPercent: 73, windowDurationMins: 300, resetsAt: "2026-08-04T12:00:00.000Z" },
      secondary: null, fetchedAt: "2026-08-04T10:00:00.000Z",
    };
  },
};
const launcher = {
  async listThreadNames() { return new Map(remoteNames); },
  async launch(input) {
    launches.push(input);
    if (input.prompt.includes("模拟启动失败")) throw new Error("fake launch failed before thread creation");
    const id = input.threadId || `019fc79b-3541-7853-a09a-${String(launches.length).padStart(12, "0")}`;
    await input.onThreadReady?.({ threadId: id, resumed: Boolean(input.threadId) });
    if (input.prompt.includes("模拟不确定结果")) throw new Error("fake disconnect after thread creation");
    monitoredThreads.push({
      ...sample,
      id,
      title: input.prompt.split("\n", 1)[0],
      preview: input.prompt,
      cwd: input.cwd,
      project: "demo",
      deepLink: `codex://threads/${id}`,
      activeTurnId: "turn-launched",
    });
    const turnId = `turn-launched-${launches.length}`;
    await input.onTurnStarted?.({ threadId: id, turnId, resumed: Boolean(input.threadId) });
    return { threadId: id, turnId, resumed: Boolean(input.threadId), deepLink: `codex://threads/${id}` };
  },
  close() {},
};
const notifier = {
  async notify(message) { notifications.push({ kind: "test", ...message }); return { delivered: true }; },
  async notifyReview(thread) { notifications.push({ kind: "review", id: thread.id, title: thread.title }); return { delivered: true }; },
};
const server = createTaskServer({ databasePath: join(sandbox, "monitor.db"), distDir: dist, monitor, launcher, quotaReader, notifier, pollInterval: 50, nameRefreshInterval: 0 });
let baseUrl;

const threadContractFields = [
  "activeStartedAt", "activeTurnId", "archived", "completedAt", "createdAt", "cwd", "deepLink", "id", "kind",
  "lane", "lastCompletedAt", "lastError", "lastFileChangeAt", "lastProgress", "lastProgressAt", "note", "pinned", "preview",
  "priority", "project", "runtimeStatus", "sortOrder", "source", "tags", "title", "updatedAt",
];

function assertThreadContract(value) {
  for (const field of threadContractFields) assert.equal(Object.hasOwn(value, field), true, `thread contract is missing ${field}`);
  assert.equal(["manual", "codex"].includes(value.kind), true);
  assert.equal(["inbox", "upcoming", "in_progress", "review", "completed"].includes(value.lane), true);
  assert.equal(["unknown", "idle", "active", "waiting", "interrupted"].includes(value.runtimeStatus), true);
  assert.equal(Array.isArray(value.tags), true);
  assert.equal(Object.hasOwn(value, value.kind === "codex" ? "hidden" : "codexThreadId"), true);
}

before(async () => {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); rmSync(sandbox, { recursive: true, force: true }); });

async function createCompletedReview(key, itemInput = {}) {
  const item = (await (await fetch(`${baseUrl}/api/work-items`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor-id": "wangfei" },
    body: JSON.stringify({
      idempotencyKey: `${key}-item`,
      title: `${key} 验收任务`,
      goal: "验证人工验收闭环",
      nextAction: "完成本轮执行并提交验收",
      acceptanceCriteria: ["用户决定最终验收结果"],
      scope: { allowed: "只操作测试数据", excluded: "不操作外部系统" },
      cwd: sandbox,
      status: "ready",
      stage: "verify",
      ...itemInput,
    }),
  })).json()).workItem;
  const started = await (await fetch(`${baseUrl}/api/work-items/${item.id}/start`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: `${key}-start`, expectedVersion: item.version }),
  })).json();
  const launch = launches.at(-1);
  const completed = await launch.onTurnCompleted({
    threadId: started.run.codexThreadId,
    turnId: started.run.codexTurnId,
    status: "completed",
    completedAt: "2026-08-09T08:30:00.000Z",
    finalMessage: "## 已完成\n完成待验收实现\n\n## 验证结果\n自动化验证通过\n\n## 风险\n需要用户验收\n\n## 需要用户决定\n无\n\n## 下一步\n请用户验收",
  });
  return { item: completed.workItem, run: completed.run, review: completed.review, launch };
}

test("serves the monitor and reports a no-token local source", async () => {
  assert.equal((await fetch(`${baseUrl}/`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/completed`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/favorites`)).status, 200);
  assert.deepEqual(await (await fetch(`${baseUrl}/api/health`)).json(), { ok: true, source: "codex-local-state", tokenUsage: false });
});

test("serves Codex quota and forwards explicit refresh requests", async () => {
  const response = await fetch(`${baseUrl}/api/quota?refresh=1`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.quota.primary.remainingPercent, 73);
  assert.equal(body.quota.primary.windowDurationMins, 300);
  assert.deepEqual(quotaReads.at(-1), { force: true });
});

test("sends a macOS notification test through the configured notifier", async () => {
  const response = await fetch(`${baseUrl}/api/notifications/test`, { method: "POST" });
  assert.equal(response.status, 200);
  assert.equal(notifications.at(-1).kind, "test");
  assert.match(notifications.at(-1).body, /待 Review/);
});

test("detects only in-progress to review transitions and ignores the initial snapshot", () => {
  const active = { id: "one", lane: "in_progress" };
  const review = { id: "one", lane: "review" };
  assert.deepEqual(findReviewTransitions(null, [review]), []);
  assert.deepEqual(findReviewTransitions([active], [review]), [review]);
  assert.deepEqual(findReviewTransitions([{ id: "one", lane: "completed" }], [review]), []);
});

test("uses Codex runtime state as the authoritative in-progress lane", async () => {
  const first = await (await fetch(`${baseUrl}/api/threads`)).json();
  assert.equal(first.threads.length, 1);
  assertThreadContract(first.threads[0]);
  assert.equal(Object.hasOwn(first.threads[0], "terminalTurns"), false);
  assert.equal(first.threads[0].lane, "in_progress");
  assert.equal(first.threads[0].deepLink, sample.deepLink);
  assert.equal(Object.hasOwn(first.threads[0], "workItemId"), true);
  assert.equal(typeof first.threads[0].workItemId, "string");

  const update = await fetch(`${baseUrl}/api/threads/${sample.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ lane: "completed", tags: ["monitor"] }) });
  assert.equal(update.status, 200);
  const after = await (await fetch(`${baseUrl}/api/threads`)).json();
  assert.equal(after.threads[0].lane, "in_progress", "active Codex runtime must override manual layout");
  assert.deepEqual(after.threads[0].tags, ["monitor"]);
});

test("rejects renaming a Codex thread from the board", async () => {
  const response = await fetch(`${baseUrl}/api/threads/${sample.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "FBA 信息缺失原因" }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /不支持字段：title/);
});

test("uses an external Codex rename even when the state database title is stale", async () => {
  const staleTitle = sample.title;
  remoteNames.set(sample.id, "Codex 外部改名");
  const listed = await (await fetch(`${baseUrl}/api/threads`)).json();
  assert.equal(sample.title, staleTitle, "the simulated SQLite title should remain stale");
  assert.equal(listed.threads.find((item) => item.id === sample.id).title, "Codex 外部改名");
  remoteNames.set(sample.id, "FBA 信息缺失原因");
});

test("keeps the deprecated task endpoint unavailable", async () => {
  assert.equal((await fetch(`${baseUrl}/api/tasks`, { method: "POST" })).status, 404);
});

test("provides versioned Work Item and idempotent Run APIs with audit attribution", async () => {
  const missingKeyResponse = await fetch(`${baseUrl}/api/work-items`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor-id": "wangfei" },
    body: JSON.stringify({ title: "不能被非幂等地创建" }),
  });
  assert.equal(missingKeyResponse.status, 400);
  assert.equal((await missingKeyResponse.json()).code, "missing_idempotency_key");

  const createdResponse = await fetch(`${baseUrl}/api/work-items`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor-id": "wangfei" },
    body: JSON.stringify({ idempotencyKey: "api-work-item", title: "API 工作任务", status: "ready", stage: "execute" }),
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).workItem;
  assert.equal(created.version, 1);
  assert.equal(created.source, null);

  const emptyRuns = await (await fetch(`${baseUrl}/api/work-items/${created.id}/runs`)).json();
  assert.deepEqual(emptyRuns.runs, []);

  const unattributedCodexResponse = await fetch(`${baseUrl}/api/work-items/${created.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-actor-type": "codex", "x-actor-id": "codex-agent" },
    body: JSON.stringify({ expectedVersion: 1, description: "缺少来源对话" }),
  });
  assert.equal(unattributedCodexResponse.status, 400);
  assert.equal((await unattributedCodexResponse.json()).code, "missing_thread_id");

  const updatedResponse = await fetch(`${baseUrl}/api/work-items/${created.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-actor-type": "codex", "x-actor-id": "codex-agent", "x-codex-thread-id": "thread-api" },
    body: JSON.stringify({ expectedVersion: 1, description: "Codex 补充的任务说明" }),
  });
  assert.equal(updatedResponse.status, 200);
  assert.equal((await updatedResponse.json()).workItem.version, 2);

  const staleResponse = await fetch(`${baseUrl}/api/work-items/${created.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-actor-id": "wangfei" },
    body: JSON.stringify({ expectedVersion: 1, title: "过期修改" }),
  });
  assert.equal(staleResponse.status, 409);
  assert.equal((await staleResponse.json()).code, "version_conflict");

  const runBody = { idempotencyKey: "api-run-one", expectedVersion: 2, mode: "explore", objective: "验证新模型", status: "queued", codexThreadId: "thread-run-one" };
  const firstRunResponse = await fetch(`${baseUrl}/api/work-items/${created.id}/runs`, {
    method: "POST", headers: { "content-type": "application/json", "x-actor-id": "wangfei" }, body: JSON.stringify(runBody),
  });
  const repeatedRunResponse = await fetch(`${baseUrl}/api/work-items/${created.id}/runs`, {
    method: "POST", headers: { "content-type": "application/json", "x-actor-id": "wangfei" }, body: JSON.stringify(runBody),
  });
  assert.equal(firstRunResponse.status, 201);
  assert.equal(repeatedRunResponse.status, 201);
  const firstRun = (await firstRunResponse.json()).run;
  assert.equal((await repeatedRunResponse.json()).run.id, firstRun.id);

  const secondRunResponse = await fetch(`${baseUrl}/api/work-items/${created.id}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor-type": "codex", "x-actor-id": "codex-agent", "x-codex-thread-id": "thread-api" },
    body: JSON.stringify({ idempotencyKey: "api-run-two", expectedVersion: 2, mode: "explore", objective: "第二次运行", status: "queued", codexThreadId: "thread-run-two" }),
  });
  assert.equal(secondRunResponse.status, 201);
  const listedRuns = await (await fetch(`${baseUrl}/api/work-items/${created.id}/runs`)).json();
  assert.equal(listedRuns.runs.length, 2);

  const audit = await (await fetch(`${baseUrl}/api/work-items/${created.id}/audit`)).json();
  assert.deepEqual(audit.events.map((event) => [event.action, event.actorId, event.codexThreadId, event.afterVersion]), [
    ["create", "wangfei", null, 1],
    ["update", "codex-agent", "thread-api", 2],
  ]);
});

test("lets only the user select a versioned today mainline", async () => {
  const created = (await (await fetch(`${baseUrl}/api/work-items`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor-id": "wangfei" },
    body: JSON.stringify({ idempotencyKey: "server-today-focus", title: "安排今日主线", status: "ready" }),
  })).json()).workItem;

  const selectedResponse = await fetch(`${baseUrl}/api/work-items/${created.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-actor-id": "wangfei" },
    body: JSON.stringify({ expectedVersion: created.version, todayFocus: true }),
  });
  assert.equal(selectedResponse.status, 200);
  const selected = (await selectedResponse.json()).workItem;
  assert.equal(selected.todayFocus, true);
  assert.equal(selected.status, "ready", "planning attention must not rewrite Work Status");

  const codexResponse = await fetch(`${baseUrl}/api/work-items/${created.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-actor-type": "codex", "x-actor-id": "manager", "x-codex-thread-id": "manager-thread" },
    body: JSON.stringify({ expectedVersion: selected.version, todayFocus: false }),
  });
  assert.equal(codexResponse.status, 403);
  assert.equal((await codexResponse.json()).code, "user_confirmation_required");

  const staleResponse = await fetch(`${baseUrl}/api/work-items/${created.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-actor-id": "wangfei" },
    body: JSON.stringify({ expectedVersion: created.version, todayFocus: false }),
  });
  assert.equal(staleResponse.status, 409);
  assert.equal((await (await fetch(`${baseUrl}/api/work-items/${created.id}`)).json()).workItem.todayFocus, true);
});

test("serves one attributable Work Item detail aggregate without copying thread history", async () => {
  const created = (await (await fetch(`${baseUrl}/api/work-items`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor-id": "wangfei" },
    body: JSON.stringify({
      idempotencyKey: "detail-aggregate-item",
      title: "统一详情聚合",
      goal: "从 Work Item 读取任务事实",
      nextAction: "检查详情接口",
      acceptanceCriteria: ["详情包含任务、Run 和上下文"],
      scope: { allowed: "只读聚合", excluded: "不复制对话全文" },
      status: "ready",
    }),
  })).json()).workItem;
  const decisionResponse = await fetch(`${baseUrl}/api/work-items/${created.id}/decisions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor-id": "wangfei" },
    body: JSON.stringify({ idempotencyKey: "detail-aggregate-decision", expectedVersion: created.version, decision: "保持只读聚合", reason: "保护上下文边界" }),
  });
  assert.equal(decisionResponse.status, 201);

  const response = await fetch(`${baseUrl}/api/work-items/${created.id}/detail`);
  assert.equal(response.status, 200);
  const detail = (await response.json()).detail;
  assert.equal(detail.workItem.id, created.id);
  assert.equal(detail.workItem.version, 2);
  assert.deepEqual(detail.runs, []);
  assert.equal(detail.context.decisions.length, 1);
  assert.deepEqual(detail.decisionRequests, []);
  assert.deepEqual(detail.reviews, []);
  assert.deepEqual(detail.reviewActions, []);
  assert.equal(JSON.stringify(detail).includes("thread history"), false);
});

test("generates frozen Context Envelopes and resumes from a Recovery Point", async () => {
  const createdResponse = await fetch(`${baseUrl}/api/work-items`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor-id": "wangfei" },
    body: JSON.stringify({
      idempotencyKey: "api-context-item",
      title: "API 上下文任务",
      goal: "验证新对话可以从看板恢复",
      nextAction: "生成 Context Envelope",
      acceptanceCriteria: ["Run 保存不可变快照"],
      scope: { allowed: "只修改测试数据", excluded: "不得触碰生产数据" },
      constraints: ["不复制完整对话"],
      status: "ready",
      stage: "execute",
    }),
  });
  assert.equal(createdResponse.status, 201);
  const item = (await createdResponse.json()).workItem;

  const envelopeResponse = await fetch(`${baseUrl}/api/work-items/${item.id}/context-envelope?expectedVersion=1&mode=implementation`);
  assert.equal(envelopeResponse.status, 200);
  const envelope = (await envelopeResponse.json()).envelope;
  assert.equal(envelope.workItem.goal, "验证新对话可以从看板恢复");
  assert.deepEqual(envelope.summarySources, [{ type: "work_item", id: item.id, version: 1 }]);

  const runResponse = await fetch(`${baseUrl}/api/work-items/${item.id}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor-id": "wangfei" },
    body: JSON.stringify({ idempotencyKey: "api-context-run", expectedVersion: 1, mode: "implementation", objective: "执行上下文快照测试" }),
  });
  assert.equal(runResponse.status, 201);
  const run = (await runResponse.json()).run;
  assert.equal(run.contextWorkItemVersion, 1);

  const unsafePause = await fetch(`${baseUrl}/api/work-items/${item.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-actor-id": "wangfei" },
    body: JSON.stringify({ expectedVersion: 1, status: "parked" }),
  });
  assert.equal(unsafePause.status, 409);
  assert.equal((await unsafePause.json()).code, "recovery_point_required");

  const recoveryResponse = await fetch(`${baseUrl}/api/work-items/${item.id}/recovery-points`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor-id": "wangfei" },
    body: JSON.stringify({
      idempotencyKey: "api-recovery-one",
      expectedVersion: 1,
      currentConclusion: "Envelope 已生成",
      completed: ["生成首个快照"],
      unresolved: ["恢复验证"],
      nextAction: "创建新 Run 验证恢复",
      status: "parked",
      sourceRunId: run.id,
    }),
  });
  assert.equal(recoveryResponse.status, 201);
  assert.equal((await recoveryResponse.json()).entity.resultingWorkItemVersion, 2);

  const updatedResponse = await fetch(`${baseUrl}/api/work-items/${item.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-actor-id": "wangfei" },
    body: JSON.stringify({ expectedVersion: 2, goal: "修改后的新目标", status: "ready" }),
  });
  assert.equal(updatedResponse.status, 200);

  const storedRun = (await (await fetch(`${baseUrl}/api/runs/${run.id}`)).json()).run;
  assert.equal(storedRun.contextWorkItemVersion, 1);
  assert.equal(storedRun.contextEnvelope.workItem.goal, "验证新对话可以从看板恢复");
  const storedContext = (await (await fetch(`${baseUrl}/api/work-items/${item.id}/context`)).json()).context;
  assert.equal(storedContext.recoveryPoints[0].nextAction, "创建新 Run 验证恢复");
});

test("offers read-only exploration instead of starting an immature implementation Run", async () => {
  const item = (await (await fetch(`${baseUrl}/api/work-items`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "api-immature-context", title: "尚未定义清楚的工作" }),
  })).json()).workItem;

  const implementationResponse = await fetch(`${baseUrl}/api/work-items/${item.id}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "api-immature-implementation", expectedVersion: 1, mode: "implementation" }),
  });
  assert.equal(implementationResponse.status, 409);
  const notReady = await implementationResponse.json();
  assert.equal(notReady.code, "work_item_not_ready");
  assert.equal(notReady.details.suggestedMode, "explore");

  const explorationResponse = await fetch(`${baseUrl}/api/work-items/${item.id}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "api-immature-explore", expectedVersion: 1, mode: "explore" }),
  });
  assert.equal(explorationResponse.status, 201);
  const exploration = (await explorationResponse.json()).run;
  assert.equal(exploration.mode, "explore");
  assert.match(exploration.contextEnvelope.scope.allowed, /只读探索/);
});

test("starts, resumes, and idempotently replays a Work Item through the Codex execution bridge", async () => {
  const item = (await (await fetch(`${baseUrl}/api/work-items`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor-id": "wangfei" },
    body: JSON.stringify({
      idempotencyKey: "api-execution-item",
      title: "执行桥测试",
      goal: "让看板启动真实 Codex task",
      nextAction: "执行最小验证",
      acceptanceCriteria: ["Run 绑定 thread 与 turn"],
      scope: { allowed: "只操作测试目录", excluded: "不修改生产数据" },
      cwd: sandbox,
      status: "ready",
      stage: "execute",
    }),
  })).json()).workItem;

  const before = launches.length;
  const request = { idempotencyKey: "api-execution-start-one", expectedVersion: 1, mode: "implementation" };
  const firstResponse = await fetch(`${baseUrl}/api/work-items/${item.id}/start`, {
    method: "POST", headers: { "content-type": "application/json", "x-actor-id": "wangfei" }, body: JSON.stringify(request),
  });
  assert.equal(firstResponse.status, 201);
  const first = await firstResponse.json();
  assert.equal(first.run.launchState, "started");
  assert.equal(first.run.status, "running");
  assert.equal(first.run.contextWorkItemVersion, 1);
  assert.ok(first.run.codexThreadId);
  assert.ok(first.run.codexTurnId);
  assert.match(launches.at(-1).prompt, /<context-envelope>/);
  assert.match(launches.at(-1).prompt, /执行桥测试/);

  const replayResponse = await fetch(`${baseUrl}/api/work-items/${item.id}/start`, {
    method: "POST", headers: { "content-type": "application/json", "x-actor-id": "wangfei" }, body: JSON.stringify(request),
  });
  assert.equal(replayResponse.status, 200);
  const replay = await replayResponse.json();
  assert.equal(replay.replayed, true);
  assert.equal(replay.run.id, first.run.id);
  assert.equal(launches.length, before + 1, "same idempotency key must not launch Codex twice");

  const resumedResponse = await fetch(`${baseUrl}/api/work-items/${item.id}/start`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "api-execution-start-two", expectedVersion: 1 }),
  });
  assert.equal(resumedResponse.status, 201);
  assert.equal((await resumedResponse.json()).resumed, true);
  assert.equal(launches.at(-1).threadId, first.run.codexThreadId);

  const newThreadResponse = await fetch(`${baseUrl}/api/work-items/${item.id}/start`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "api-execution-start-three", expectedVersion: 1, threadStrategy: "new" }),
  });
  assert.equal(newThreadResponse.status, 201);
  assert.equal((await newThreadResponse.json()).resumed, false);
  assert.equal(launches.at(-1).threadId, null);
});

test("synchronizes a completed Codex turn into one Review Submission and in_review Work Status", async () => {
  const item = (await (await fetch(`${baseUrl}/api/work-items`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor-id": "wangfei" },
    body: JSON.stringify({
      idempotencyKey: "api-review-item",
      title: "M3.1 完成事件测试",
      goal: "把真实完成事件同步为待验收",
      nextAction: "生成 Review Submission",
      acceptanceCriteria: ["Run completed", "Work Item in_review"],
      scope: { allowed: "只操作测试数据", excluded: "不操作外部系统" },
      cwd: sandbox,
      status: "ready",
      stage: "verify",
    }),
  })).json()).workItem;
  const startResponse = await fetch(`${baseUrl}/api/work-items/${item.id}/start`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "api-review-start", expectedVersion: 1 }),
  });
  assert.equal(startResponse.status, 201);
  const run = (await startResponse.json()).run;
  const launch = launches.at(-1);
  const event = {
    threadId: run.codexThreadId,
    turnId: run.codexTurnId,
    status: "completed",
    completedAt: "2026-08-09T06:00:00.000Z",
    finalMessage: "## 已完成\n实现执行闭环\n\n## 验证结果\n测试全部通过\n\n## 风险\n存在人工验收步骤\n\n## 需要用户决定\n无\n\n## 下一步\n请用户验收",
  };
  const completed = await launch.onTurnCompleted(event);
  assert.equal(completed.replayed, false);
  assert.equal(completed.run.status, "completed");
  assert.equal(completed.workItem.status, "in_review");
  assert.equal(completed.review.completedSummary, "实现执行闭环");
  assert.equal(completed.review.verificationSummary, "测试全部通过");
  assert.equal(completed.review.sourceUri, `codex://threads/${run.codexThreadId}?turn=${run.codexTurnId}`);

  const storedRun = (await (await fetch(`${baseUrl}/api/runs/${run.id}`)).json()).run;
  assert.equal(storedRun.status, "completed");
  assert.ok(storedRun.terminalEventKey);
  assert.equal(storedRun.terminalAt, event.completedAt);
  const listed = await (await fetch(`${baseUrl}/api/work-items/${item.id}/reviews`)).json();
  assert.equal(listed.reviews.length, 1);
  const byRun = await (await fetch(`${baseUrl}/api/runs/${run.id}/review`)).json();
  assert.equal(byRun.review.id, completed.review.id);

  const replayed = await launch.onTurnCompleted(event);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.review.id, completed.review.id);
  const listedAgain = await (await fetch(`${baseUrl}/api/work-items/${item.id}/reviews`)).json();
  assert.equal(listedAgain.reviews.length, 1);
  assert.equal((await (await fetch(`${baseUrl}/api/work-items/${item.id}`)).json()).workItem.status, "in_review");
});

test("allows only a user to approve the latest Review and complete the Work Item idempotently", async () => {
  const prepared = await createCompletedReview("api-review-approve");
  const body = {
    idempotencyKey: "api-review-approve-action",
    action: "approve",
    expectedReviewVersion: prepared.review.version,
    expectedWorkItemVersion: prepared.item.version,
    feedback: "验收通过。",
  };
  const staleAttempt = await fetch(`${baseUrl}/api/reviews/${prepared.review.id}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor-id": "wangfei" },
    body: JSON.stringify({ ...body, idempotencyKey: "api-review-approve-stale", expectedWorkItemVersion: prepared.item.version - 1 }),
  });
  assert.equal(staleAttempt.status, 409);
  assert.equal((await staleAttempt.json()).code, "version_conflict");

  const codexAttempt = await fetch(`${baseUrl}/api/reviews/${prepared.review.id}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor-type": "codex", "x-codex-thread-id": prepared.run.codexThreadId },
    body: JSON.stringify({ ...body, idempotencyKey: "api-review-approve-codex" }),
  });
  assert.equal(codexAttempt.status, 403);
  assert.equal((await codexAttempt.json()).code, "user_confirmation_required");

  const response = await fetch(`${baseUrl}/api/reviews/${prepared.review.id}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor-id": "wangfei" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 201);
  const approved = await response.json();
  assert.equal(approved.reviewAction.action, "approve");
  assert.equal(approved.reviewAction.state, "applied");
  assert.equal(approved.workItem.status, "done");
  assert.equal(approved.reviewedRun.status, "completed");
  assert.equal(approved.revisionRun, null);

  const replay = await fetch(`${baseUrl}/api/reviews/${prepared.review.id}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor-id": "wangfei" },
    body: JSON.stringify(body),
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
  assert.equal((await (await fetch(`${baseUrl}/api/reviews/${prepared.review.id}/action`)).json()).reviewAction.id, approved.reviewAction.id);
});

test("returns a Review for changes by creating a new Run on the same Work Item and main task", async () => {
  const prepared = await createCompletedReview("api-review-changes");
  const beforeLaunches = launches.length;
  const body = {
    idempotencyKey: "api-review-changes-action",
    action: "request_changes",
    expectedReviewVersion: prepared.review.version,
    expectedWorkItemVersion: prepared.item.version,
    feedback: "补充失败分支测试，并明确验证结果。",
  };
  const response = await fetch(`${baseUrl}/api/reviews/${prepared.review.id}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor-id": "wangfei" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 201);
  const returned = await response.json();
  assert.equal(returned.reviewAction.action, "request_changes");
  assert.equal(returned.reviewAction.state, "applied");
  assert.equal(returned.reviewAction.revisionRunId, returned.revisionRun.id);
  assert.equal(returned.reviewedRun.status, "completed");
  assert.equal(returned.revisionRun.status, "running");
  assert.equal(returned.revisionRun.workItemId, prepared.item.id);
  assert.notEqual(returned.revisionRun.id, prepared.run.id);
  assert.equal(returned.revisionRun.codexThreadId, prepared.run.codexThreadId);
  assert.notEqual(returned.revisionRun.codexTurnId, prepared.run.codexTurnId);
  assert.equal(returned.workItem.status, "active");
  assert.match(returned.workItem.nextAction, /补充失败分支测试/);
  assert.match(launches.at(-1).prompt, /补充失败分支测试/);
  assert.equal(launches.at(-1).threadId, prepared.run.codexThreadId);
  assert.match(JSON.stringify(returned.revisionRun.contextEnvelope.evidenceRefs), /验收退回意见/);

  const replay = await fetch(`${baseUrl}/api/reviews/${prepared.review.id}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor-id": "wangfei" },
    body: JSON.stringify(body),
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
  assert.equal(launches.length, beforeLaunches + 1, "replaying a review action must not launch another revision Run");
  assert.equal((await (await fetch(`${baseUrl}/api/work-items/${prepared.item.id}/runs`)).json()).runs.length, 2);

  const revisionLaunch = launches.at(-1);
  const completed = await revisionLaunch.onTurnCompleted({
    threadId: returned.revisionRun.codexThreadId,
    turnId: returned.revisionRun.codexTurnId,
    status: "completed",
    completedAt: "2026-08-09T08:31:00.000Z",
    finalMessage: "## 已完成\n已按验收意见修改\n\n## 验证结果\n失败分支测试通过\n\n## 风险\n无\n\n## 需要用户决定\n无\n\n## 下一步\n再次验收",
  });
  assert.equal(completed.workItem.status, "in_review");
  assert.equal((await (await fetch(`${baseUrl}/api/work-items/${prepared.item.id}/reviews`)).json()).reviews.length, 2);
  const audit = (await (await fetch(`${baseUrl}/api/review-actions/${returned.reviewAction.id}/audit`)).json()).events;
  assert.deepEqual(audit.map((event) => event.action), ["create", "state_applied"]);
});

test("accepts the current result and creates one independent linked follow-up Work Item", async () => {
  const prepared = await createCompletedReview("api-review-follow-up");
  const body = {
    idempotencyKey: "api-review-follow-up-action",
    action: "accept_with_follow_up",
    expectedReviewVersion: prepared.review.version,
    expectedWorkItemVersion: prepared.item.version,
    feedback: "当前范围验收通过，性能优化另开任务。",
    followUp: {
      title: "优化验收链路性能",
      goal: "降低大量 Review 查询的延迟",
      nextAction: "先测量查询基线",
      acceptanceCriteria: ["有可重复的性能基线"],
      scope: { allowed: "只做性能分析", excluded: "不改变业务语义" },
      stage: "explore",
      tags: ["follow-up"],
    },
  };
  const response = await fetch(`${baseUrl}/api/reviews/${prepared.review.id}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor-id": "wangfei" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 201);
  const accepted = await response.json();
  assert.equal(accepted.reviewAction.action, "accept_with_follow_up");
  assert.equal(accepted.workItem.status, "done");
  assert.equal(accepted.followUpWorkItem.status, "inbox");
  assert.equal(accepted.followUpWorkItem.title, "优化验收链路性能");
  assert.notEqual(accepted.followUpWorkItem.id, prepared.item.id);
  assert.equal(accepted.reviewAction.followUpWorkItemId, accepted.followUpWorkItem.id);
  assert.equal((await (await fetch(`${baseUrl}/api/work-items/${accepted.followUpWorkItem.id}/runs`)).json()).runs.length, 0);
  const followUpContext = (await (await fetch(`${baseUrl}/api/work-items/${accepted.followUpWorkItem.id}/context`)).json()).context;
  assert.deepEqual(followUpContext.relations.map((relation) => [relation.relationType, relation.targetWorkItemId]), [["parent", prepared.item.id]]);

  const replay = await fetch(`${baseUrl}/api/reviews/${prepared.review.id}/actions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor-id": "wangfei" },
    body: JSON.stringify(body),
  });
  assert.equal(replay.status, 200);
  const replayed = await replay.json();
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.followUpWorkItem.id, accepted.followUpWorkItem.id);
});

test("keeps Review feedback durable and never auto-retries failed or uncertain revision launches", async () => {
  async function exercise(key, feedback, expectedCode, expectedState) {
    const prepared = await createCompletedReview(key);
    const body = {
      idempotencyKey: `${key}-action`,
      action: "request_changes",
      expectedReviewVersion: prepared.review.version,
      expectedWorkItemVersion: prepared.item.version,
      feedback,
    };
    const before = launches.length;
    const response = await fetch(`${baseUrl}/api/reviews/${prepared.review.id}/actions`, {
      method: "POST", headers: { "content-type": "application/json", "x-actor-id": "wangfei" }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 502);
    const failed = await response.json();
    assert.equal(failed.code, expectedCode);
    assert.equal(failed.details.reviewAction.state, expectedState);
    assert.equal(failed.details.revisionRun.workItemId, prepared.item.id);
    assert.match((await (await fetch(`${baseUrl}/api/work-items/${prepared.item.id}`)).json()).workItem.nextAction, /模拟/);

    const replay = await fetch(`${baseUrl}/api/reviews/${prepared.review.id}/actions`, {
      method: "POST", headers: { "content-type": "application/json", "x-actor-id": "wangfei" }, body: JSON.stringify(body),
    });
    assert.equal(replay.status, 200);
    const replayed = await replay.json();
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.reviewAction.state, expectedState);
    assert.equal(launches.length, before + 1, "a resolved failed/uncertain review action must not automatically launch again");
  }

  await exercise("api-review-revision-failed", "模拟启动失败，并保留退回意见。", "review_revision_failed", "failed");
  await exercise("api-review-revision-uncertain", "模拟不确定结果，并禁止自动重试。", "review_revision_uncertain", "uncertain");
});

test("routes a structured Decision Request answer back to the exact original Run", async () => {
  const item = (await (await fetch(`${baseUrl}/api/work-items`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor-id": "wangfei" },
    body: JSON.stringify({
      idempotencyKey: "api-decision-item",
      title: "M3.2 决策路由测试",
      goal: "让用户在看板回答后继续原 Codex task",
      nextAction: "选择安全的实现策略",
      acceptanceCriteria: ["答案只进入原 task", "回答后继续同一 Run"],
      scope: { allowed: "只操作测试数据", excluded: "不操作外部系统" },
      cwd: sandbox,
      status: "ready",
      stage: "execute",
    }),
  })).json()).workItem;
  const started = await (await fetch(`${baseUrl}/api/work-items/${item.id}/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "api-decision-start", expectedVersion: 1 }),
  })).json();
  const initialRun = started.run;
  const initialLaunch = launches.at(-1);
  const requestBody = {
    idempotencyKey: "api-decision-request",
    expectedRunVersion: initialRun.version,
    expectedWorkItemVersion: item.version,
    sourceTurnId: initialRun.codexTurnId,
    question: "应采用哪个实现策略？",
    contextSummary: "方案 A 更小且可逆，方案 B 会扩大范围。",
    options: [
      { id: "safe", label: "采用方案 A", description: "保持当前范围" },
      { id: "expand", label: "采用方案 B", description: "扩大实现范围" },
    ],
    recommendedOptionId: "safe",
    recommendationReason: "风险更低且满足本轮目标",
    risks: "方案 B 会增加回归范围",
    defaultConsequence: "不回答则 Run 保持等待，不继续执行",
  };

  const wrongSource = await fetch(`${baseUrl}/api/runs/${initialRun.id}/decision-requests`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor-type": "codex", "x-actor-id": "codex-agent", "x-codex-thread-id": "wrong-thread" },
    body: JSON.stringify({ ...requestBody, idempotencyKey: "api-decision-wrong-source" }),
  });
  assert.equal(wrongSource.status, 409);
  assert.equal((await wrongSource.json()).code, "decision_source_mismatch");

  const createdResponse = await fetch(`${baseUrl}/api/runs/${initialRun.id}/decision-requests`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor-type": "codex", "x-actor-id": "codex-agent", "x-codex-thread-id": initialRun.codexThreadId },
    body: JSON.stringify(requestBody),
  });
  assert.equal(createdResponse.status, 201);
  const decisionRequest = (await createdResponse.json()).decisionRequest;
  assert.equal(decisionRequest.status, "pending");
  assert.equal(decisionRequest.sourceThreadId, initialRun.codexThreadId);
  assert.equal(decisionRequest.sourceTurnId, initialRun.codexTurnId);
  assert.equal((await (await fetch(`${baseUrl}/api/runs/${initialRun.id}`)).json()).run.status, "waiting");
  const awaitingItem = (await (await fetch(`${baseUrl}/api/work-items/${item.id}`)).json()).workItem;
  assert.equal(awaitingItem.status, "awaiting_decision");

  const deferred = await initialLaunch.onTurnCompleted({
    threadId: initialRun.codexThreadId,
    turnId: initialRun.codexTurnId,
    status: "completed",
    completedAt: "2026-08-09T07:00:00.000Z",
    finalMessage: "已提交结构化决定请求，等待用户回答。",
  });
  assert.equal(deferred.deferredForDecision, true);
  assert.equal(deferred.run.status, "waiting");
  assert.equal((await (await fetch(`${baseUrl}/api/work-items/${item.id}/reviews`)).json()).reviews.length, 0);

  const waitingRun = (await (await fetch(`${baseUrl}/api/runs/${initialRun.id}`)).json()).run;
  const beforeAnswerLaunches = launches.length;
  const answerBody = {
    idempotencyKey: "api-decision-answer",
    expectedVersion: decisionRequest.version,
    expectedRunVersion: waitingRun.version,
    expectedWorkItemVersion: awaitingItem.version,
    optionId: "safe",
    answerText: "按最小可逆方案继续。",
  };
  const answerResponse = await fetch(`${baseUrl}/api/decision-requests/${decisionRequest.id}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor-id": "wangfei" },
    body: JSON.stringify(answerBody),
  });
  assert.equal(answerResponse.status, 201);
  const answered = await answerResponse.json();
  assert.equal(answered.decisionRequest.status, "answered");
  assert.equal(answered.decisionRequest.routingState, "routed");
  assert.equal(answered.decisionRequest.answerThreadId, initialRun.codexThreadId);
  assert.ok(answered.decisionRequest.answerTurnId);
  assert.equal(answered.run.status, "running");
  assert.equal(answered.run.codexThreadId, initialRun.codexThreadId);
  assert.equal(answered.run.codexTurnId, answered.decisionRequest.answerTurnId);
  assert.equal(answered.workItem.status, "active");
  assert.equal(launches.at(-1).threadId, initialRun.codexThreadId);
  assert.match(launches.at(-1).prompt, /按最小可逆方案继续/);

  const replayResponse = await fetch(`${baseUrl}/api/decision-requests/${decisionRequest.id}/answer`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor-id": "wangfei" },
    body: JSON.stringify(answerBody),
  });
  assert.equal(replayResponse.status, 200);
  assert.equal((await replayResponse.json()).replayed, true);
  assert.equal(launches.length, beforeAnswerLaunches + 1, "same answer idempotency key must not create another turn");

  const answerLaunch = launches.at(-1);
  const completed = await answerLaunch.onTurnCompleted({
    threadId: answered.run.codexThreadId,
    turnId: answered.run.codexTurnId,
    status: "completed",
    completedAt: "2026-08-09T07:01:00.000Z",
    finalMessage: "## 已完成\n按用户决定完成实现\n\n## 验证结果\n路由测试通过\n\n## 风险\n无\n\n## 需要用户决定\n无\n\n## 下一步\n请用户验收",
  });
  assert.equal(completed.run.status, "completed");
  assert.equal(completed.workItem.status, "in_review");
  assert.equal(completed.review.completedSummary, "按用户决定完成实现");

  const storedContext = (await (await fetch(`${baseUrl}/api/work-items/${item.id}/context`)).json()).context;
  assert.equal(storedContext.decisions.length, 1);
  assert.match(storedContext.decisions[0].decision, /方案 A/);
  const listed = (await (await fetch(`${baseUrl}/api/work-items/${item.id}/decision-requests`)).json()).decisionRequests;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].answerTurnId, answered.run.codexTurnId);
  assert.equal(listed[0].sourceUri, `codex://threads/${initialRun.codexThreadId}?turn=${initialRun.codexTurnId}`);
  assert.equal(listed[0].answerUri, `codex://threads/${answered.run.codexThreadId}?turn=${answered.run.codexTurnId}`);
  const audit = (await (await fetch(`${baseUrl}/api/decision-requests/${decisionRequest.id}/audit`)).json()).events;
  assert.deepEqual(audit.map((event) => [event.action, event.actorType, event.actorId]), [
    ["create", "codex", "codex-agent"],
    ["answer_claimed", "user", "wangfei"],
    ["route_routed", "system", "decision-router"],
  ]);
});

test("distinguishes safe decision-route retries from uncertain Codex side effects", async () => {
  async function prepare(key) {
    const item = (await (await fetch(`${baseUrl}/api/work-items`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: `${key}-item`, title: `${key} 决策失败测试`, cwd: sandbox }),
    })).json()).workItem;
    const run = (await (await fetch(`${baseUrl}/api/work-items/${item.id}/start`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: `${key}-start`, expectedVersion: 1, mode: "explore" }),
    })).json()).run;
    const request = (await (await fetch(`${baseUrl}/api/runs/${run.id}/decision-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-actor-type": "codex", "x-codex-thread-id": run.codexThreadId },
      body: JSON.stringify({
        idempotencyKey: `${key}-request`, expectedRunVersion: run.version, expectedWorkItemVersion: item.version,
        sourceTurnId: run.codexTurnId, question: "是否继续？", contextSummary: "验证外部副作用失败语义。",
        options: [{ id: "yes", label: "继续" }, { id: "no", label: "停止" }], recommendedOptionId: "yes",
      }),
    })).json()).decisionRequest;
    return {
      item: (await (await fetch(`${baseUrl}/api/work-items/${item.id}`)).json()).workItem,
      run: (await (await fetch(`${baseUrl}/api/runs/${run.id}`)).json()).run,
      request,
    };
  }

  const failed = await prepare("api-decision-route-failed");
  const failedAnswer = {
    idempotencyKey: "api-decision-route-failed-answer", expectedVersion: failed.request.version,
    expectedRunVersion: failed.run.version, expectedWorkItemVersion: failed.item.version,
    optionId: "yes", answerText: "模拟启动失败",
  };
  const beforeFailed = launches.length;
  const failedResponse = await fetch(`${baseUrl}/api/decision-requests/${failed.request.id}/answer`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(failedAnswer),
  });
  assert.equal(failedResponse.status, 502);
  assert.equal((await failedResponse.json()).code, "decision_route_failed");
  const failedRetry = await fetch(`${baseUrl}/api/decision-requests/${failed.request.id}/answer`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(failedAnswer),
  });
  assert.equal(failedRetry.status, 502);
  assert.equal(launches.length, beforeFailed + 2, "failure before thread/resume is safe to retry with the same key");

  const uncertain = await prepare("api-decision-route-uncertain");
  const uncertainAnswer = {
    idempotencyKey: "api-decision-route-uncertain-answer", expectedVersion: uncertain.request.version,
    expectedRunVersion: uncertain.run.version, expectedWorkItemVersion: uncertain.item.version,
    optionId: "yes", answerText: "模拟不确定结果",
  };
  const beforeUncertain = launches.length;
  const uncertainResponse = await fetch(`${baseUrl}/api/decision-requests/${uncertain.request.id}/answer`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(uncertainAnswer),
  });
  assert.equal(uncertainResponse.status, 502);
  assert.equal((await uncertainResponse.json()).code, "decision_route_uncertain");
  const uncertainRetry = await fetch(`${baseUrl}/api/decision-requests/${uncertain.request.id}/answer`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(uncertainAnswer),
  });
  assert.equal(uncertainRetry.status, 409);
  assert.equal((await uncertainRetry.json()).code, "decision_route_uncertain");
  assert.equal(launches.length, beforeUncertain + 1, "uncertain routing must not start another turn automatically");
});

test("records interrupted turns without fabricating a Review Submission", async () => {
  const item = (await (await fetch(`${baseUrl}/api/work-items`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "api-interrupted-item", title: "M3.1 中断测试", cwd: sandbox }),
  })).json()).workItem;
  const started = await fetch(`${baseUrl}/api/work-items/${item.id}/start`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "api-interrupted-start", expectedVersion: 1, mode: "explore" }),
  });
  const run = (await started.json()).run;
  const synchronized = await launches.at(-1).onTurnCompleted({
    threadId: run.codexThreadId, turnId: run.codexTurnId, status: "interrupted", finalMessage: "", completedAt: "2026-08-09T06:01:00.000Z",
  });
  assert.equal(synchronized.run.status, "interrupted");
  assert.equal(synchronized.review, null);
  assert.equal(synchronized.workItem.status, "inbox");
  assert.deepEqual((await (await fetch(`${baseUrl}/api/work-items/${item.id}/reviews`)).json()).reviews, []);
});

test("does not overwrite a user's later Work Status when a completion event arrives late", async () => {
  const item = (await (await fetch(`${baseUrl}/api/work-items`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "api-late-completion-item", title: "M3.1 迟到事件测试", cwd: sandbox }),
  })).json()).workItem;
  const started = await fetch(`${baseUrl}/api/work-items/${item.id}/start`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "api-late-completion-start", expectedVersion: 1, mode: "explore" }),
  });
  const run = (await started.json()).run;
  const canceled = await fetch(`${baseUrl}/api/work-items/${item.id}`, {
    method: "PATCH", headers: { "content-type": "application/json", "x-actor-id": "wangfei" },
    body: JSON.stringify({ expectedVersion: 1, status: "canceled" }),
  });
  assert.equal(canceled.status, 200);
  const synchronized = await launches.at(-1).onTurnCompleted({
    threadId: run.codexThreadId, turnId: run.codexTurnId, status: "completed", finalMessage: "## 已完成\n迟到结果", completedAt: "2026-08-09T06:01:30.000Z",
  });
  assert.equal(synchronized.run.status, "completed");
  assert.ok(synchronized.review);
  assert.equal(synchronized.workItem.status, "canceled");
});

test("reconciles a missed completion callback from the persisted Codex rollout state", async () => {
  const item = (await (await fetch(`${baseUrl}/api/work-items`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "api-reconcile-item", title: "M3.1 重启恢复测试", cwd: sandbox }),
  })).json()).workItem;
  const started = await fetch(`${baseUrl}/api/work-items/${item.id}/start`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "api-reconcile-start", expectedVersion: 1, mode: "explore" }),
  });
  const run = (await started.json()).run;
  const monitored = monitoredThreads.findLast((thread) => thread.id === run.codexThreadId);
  monitored.runtimeStatus = "idle";
  monitored.activeTurnId = null;
  monitored.lastCompletedTurnId = run.codexTurnId;
  monitored.lastCompletedAt = "2026-08-09T06:02:00.000Z";
  monitored.lastProgress = "## 已完成\n从 rollout 恢复完成事件";
  await fetch(`${baseUrl}/api/threads`);

  const stored = (await (await fetch(`${baseUrl}/api/runs/${run.id}`)).json()).run;
  assert.equal(stored.status, "completed");
  const reviews = (await (await fetch(`${baseUrl}/api/work-items/${item.id}/reviews`)).json()).reviews;
  assert.equal(reviews.length, 1);
  assert.match(reviews[0].completedSummary, /rollout 恢复/);
});

test("persists failed and uncertain launches without automatically retrying them", async () => {
  async function createFailureItem(key, title) {
    return (await (await fetch(`${baseUrl}/api/work-items`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: key, title, cwd: sandbox }),
    })).json()).workItem;
  }

  const failedItem = await createFailureItem("api-launch-failed-item", "模拟启动失败");
  const failedRequest = { idempotencyKey: "api-launch-failed", expectedVersion: 1, mode: "explore" };
  const beforeFailure = launches.length;
  const failedResponse = await fetch(`${baseUrl}/api/work-items/${failedItem.id}/start`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(failedRequest),
  });
  assert.equal(failedResponse.status, 502);
  const failed = await failedResponse.json();
  assert.equal(failed.code, "codex_launch_failed");
  assert.equal(failed.details.run.launchState, "failed");
  const failedReplay = await fetch(`${baseUrl}/api/work-items/${failedItem.id}/start`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(failedRequest),
  });
  assert.equal(failedReplay.status, 200);
  assert.equal((await failedReplay.json()).run.launchState, "failed");
  assert.equal(launches.length, beforeFailure + 1);

  const uncertainItem = await createFailureItem("api-launch-uncertain-item", "模拟不确定结果");
  const uncertainResponse = await fetch(`${baseUrl}/api/work-items/${uncertainItem.id}/start`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "api-launch-uncertain", expectedVersion: 1, mode: "explore" }),
  });
  assert.equal(uncertainResponse.status, 502);
  const uncertain = await uncertainResponse.json();
  assert.equal(uncertain.code, "codex_launch_uncertain");
  assert.equal(uncertain.details.run.launchState, "uncertain");
  assert.ok(uncertain.details.run.codexThreadId);
});

test("starts a manual task in Codex and replaces the manual card with its real thread", async () => {
  const createdResponse = await fetch(`${baseUrl}/api/items`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "修复登录问题", note: "补回归测试", project: "demo", cwd: sandbox, priority: "high", lane: "upcoming" }),
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).item;
  assert.equal(created.cwd, sandbox);

  const startedResponse = await fetch(`${baseUrl}/api/items/${created.id}/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(startedResponse.status, 200);
  const started = await startedResponse.json();
  const deepLink = new URL(started.deepLink);
  assert.equal(deepLink.protocol, "codex:");
  assert.equal(deepLink.hostname, "threads");
  assert.equal(deepLink.pathname, `/${started.threadId}`);
  assert.deepEqual(launches.at(-1), { cwd: sandbox, prompt: "修复登录问题\n\n补回归测试" });

  const listed = await (await fetch(`${baseUrl}/api/threads`)).json();
  assert.equal(listed.threads.some((item) => item.id === created.id), false, "bound manual card must not remain as a duplicate");
  const bound = listed.threads.find((item) => item.id === started.threadId);
  assert.equal(bound.kind, "codex");
  assert.equal(bound.title, "修复登录问题");
  assert.equal(bound.lane, "in_progress");
  assert.equal(bound.priority, "high");
});

test("requires an existing absolute working directory before launch", async () => {
  const response = await fetch(`${baseUrl}/api/items`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "目录不明确", cwd: "relative/project", lane: "upcoming" }),
  });
  const task = (await response.json()).item;
  const started = await fetch(`${baseUrl}/api/items/${task.id}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(started.status, 400);
  assert.match((await started.json()).error, /绝对路径/);
});

test("only starts tasks from the todo lane", async () => {
  const response = await fetch(`${baseUrl}/api/items`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "仍在收集箱", cwd: sandbox, lane: "inbox" }),
  });
  const task = (await response.json()).item;
  const started = await fetch(`${baseUrl}/api/items/${task.id}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(started.status, 409);
  assert.match((await started.json()).error, /移入待办列/);
});

test("persists pin state and deletes manual inbox or todo items", async () => {
  const createdResponse = await fetch(`${baseUrl}/api/items`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "可置顶并删除", lane: "inbox" }),
  });
  const task = (await createdResponse.json()).item;
  assertThreadContract(task);

  const pinnedResponse = await fetch(`${baseUrl}/api/items/${task.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pinned: true }),
  });
  assert.equal(pinnedResponse.status, 200);
  assert.equal((await pinnedResponse.json()).item.pinned, true);

  const listed = await (await fetch(`${baseUrl}/api/threads`)).json();
  assert.equal(listed.threads.find((item) => item.id === task.id).pinned, true);
  assert.equal((await fetch(`${baseUrl}/api/items/${task.id}`, { method: "DELETE" })).status, 204);
  const afterDelete = await (await fetch(`${baseUrl}/api/threads`)).json();
  assert.equal(afterDelete.threads.some((item) => item.id === task.id), false);
});

test("persists favorite state for a completed Codex thread", async () => {
  const response = await fetch(`${baseUrl}/api/threads/${sample.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pinned: true }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).metadata.pinned, true);
  const listed = await (await fetch(`${baseUrl}/api/threads`)).json();
  assert.equal(listed.threads.find((item) => item.id === sample.id).pinned, true);
});

test("moves first and subsequent completions through review before completed", async () => {
  sample.runtimeStatus = "idle";
  sample.activeTurnId = null;
  sample.lastCompletedAt = "2099-01-01T00:00:00.000Z";

  let listed = await (await fetch(`${baseUrl}/api/threads`)).json();
  assert.equal(listed.threads.find((item) => item.id === sample.id).lane, "review", "first observed completion should require review");

  const accepted = await fetch(`${baseUrl}/api/threads/${sample.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lane: "completed" }),
  });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).metadata.lastSeenCompletion, sample.lastCompletedAt);
  listed = await (await fetch(`${baseUrl}/api/threads`)).json();
  assert.equal(listed.threads.find((item) => item.id === sample.id).lane, "completed", "accepted completion should stay completed");

  sample.lastCompletedAt = "2099-01-02T00:00:00.000Z";
  listed = await (await fetch(`${baseUrl}/api/threads`)).json();
  assert.equal(listed.threads.find((item) => item.id === sample.id).lane, "review", "a later completion should require review again");
  await fetch(`${baseUrl}/api/threads/${sample.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ lane: "completed" }) });
});

test("acknowledges an interruption until a newer interruption occurs", async () => {
  sample.runtimeStatus = "interrupted";
  sample.lastInterruptedAt = "2099-01-03T00:00:00.000Z";

  let listed = await (await fetch(`${baseUrl}/api/threads`)).json();
  assert.equal(listed.threads.find((item) => item.id === sample.id).lane, "review");

  const accepted = await fetch(`${baseUrl}/api/threads/${sample.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lane: "completed" }),
  });
  assert.equal((await accepted.json()).metadata.lastSeenInterruption, sample.lastInterruptedAt);
  listed = await (await fetch(`${baseUrl}/api/threads`)).json();
  assert.equal(listed.threads.find((item) => item.id === sample.id).lane, "completed", "accepted interruption should stay completed");

  sample.lastInterruptedAt = "2099-01-04T00:00:00.000Z";
  listed = await (await fetch(`${baseUrl}/api/threads`)).json();
  assert.equal(listed.threads.find((item) => item.id === sample.id).lane, "review", "a newer interruption should require review again");
});
