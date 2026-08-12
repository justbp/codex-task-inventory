import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createRoundtableService } from "../server/roundtable.mjs";

function createHarness(agentRunner) {
  const sandbox = mkdtempSync(join(tmpdir(), "codex-roundtable-"));
  const db = new DatabaseSync(join(sandbox, "roundtable.db"));
  const changes = [];
  const service = createRoundtableService({
    db,
    agentRunner,
    onChange(event) { changes.push(event); },
  });
  return {
    sandbox,
    db,
    service,
    changes,
    close() {
      service.close();
      db.close();
      rmSync(sandbox, { recursive: true, force: true });
    },
  };
}

async function waitFor(predicate, message = "等待圆桌状态超时") {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function completedRunner(calls) {
  return {
    async run(agent, input) {
      calls.push({ agent, ...input });
      const line = 20 + calls.length;
      return {
        text: [
          `${agent} 在 ${input.phase} 阶段的独立结论。`,
          `代码证据：/Users/wangfei/Developer/smart_approval_agent/src/${agent}.ts:${line}:3`,
          `外部证据：https://example.com/research/${agent}/${input.phase}.`,
        ].join("\n"),
        model: `${agent}-test-model`,
        usage: { inputTokens: 10, outputTokens: 20 },
      };
    },
  };
}

test("creates a topic and automatically runs independent research, anonymous critique, and synthesis", async () => {
  const calls = [];
  const harness = createHarness(completedRunner(calls));
  try {
    const created = harness.service.create({
      title: "评估 Agent 架构",
      prompt: "分析当前 Agent 为什么难维护，并寻找替代方案",
      cwd: harness.sandbox,
    });
    assert.equal(created.title, "评估 Agent 架构");
    assert.equal(created.cwd, harness.sandbox);

    const detail = await waitFor(() => {
      const value = harness.service.get(created.id);
      return value?.topic.status === "completed" ? value : null;
    });

    assert.equal(calls.length, 7, "three research calls, three critiques, and one synthesis are expected");
    assert.deepEqual(calls.slice(0, 3).map((call) => call.agent), ["codex", "cursor", "minimax"]);
    assert.deepEqual(calls.slice(0, 3).map((call) => call.phase), ["research", "research", "research"]);
    for (const call of calls.slice(0, 3)) {
      assert.match(call.prompt, /看不到其他 Agent 的回答/);
      assert.match(call.prompt, /不套固定章节模板/);
      assert.doesNotMatch(call.prompt, /匿名报告 [A-C]/, "the independent round must not contain another agent's answer");
      assert.equal(call.cwd, harness.sandbox);
    }

    assert.deepEqual(calls.slice(3, 6).map((call) => call.phase), ["critique", "critique", "critique"]);
    for (const call of calls.slice(3, 6)) {
      assert.match(call.prompt, /匿名报告 A/);
      assert.match(call.prompt, /至少两个关键漏洞或冲突/);
      assert.match(call.prompt, /不要按多数意见投票/);
    }
    assert.equal(calls[6].agent, "codex");
    assert.equal(calls[6].phase, "summary");
    assert.match(calls[6].prompt, /不要为了形成共识而掩盖少数意见/);

    assert.equal(detail.messages.filter((message) => message.kind === "question").length, 1);
    assert.equal(detail.messages.filter((message) => message.kind === "analysis").length, 3);
    assert.equal(detail.messages.filter((message) => message.kind === "critique").length, 3);
    assert.equal(detail.messages.filter((message) => message.kind === "summary").length, 1);
    const summary = detail.messages.find((message) => message.kind === "summary");
    assert.equal(summary.author, "主持人");
    assert.equal(summary.role, "moderator");
    assert.match(calls[6].prompt, /## 已证实/);
    assert.match(calls[6].prompt, /## 未证实/);
    assert.deepEqual(new Set(detail.messages.filter((message) => message.role === "agent").map((message) => message.metadata.agent)), new Set(["codex", "cursor", "minimax"]));
    assert.equal(harness.changes.some((event) => event.topicId === created.id), true);
  } finally {
    harness.close();
  }
});

test("extracts web and code evidence and supports a later user turn", async () => {
  const calls = [];
  const harness = createHarness(completedRunner(calls));
  try {
    const topic = harness.service.create({ prompt: "先调查维护成本", cwd: harness.sandbox });
    await waitFor(() => harness.service.get(topic.id)?.topic.status === "completed");

    let detail = harness.service.get(topic.id);
    assert.equal(detail.evidence.some((item) => item.type === "web" && item.value.startsWith("https://example.com/research/")), true);
    assert.equal(detail.evidence.some((item) => item.type === "code" && item.value.includes("/Users/wangfei/Developer/smart_approval_agent/src/")), true);
    assert.equal(detail.evidence.every((item) => detail.messages.some((message) => message.id === item.messageId)), true);

    const response = harness.service.respond(topic.id, { content: "补充比较状态机和动态工具发现", target: "all" });
    assert.equal(response.id, topic.id);
    detail = await waitFor(() => {
      const value = harness.service.get(topic.id);
      return calls.length === 14 && value?.topic.status === "completed" ? value : null;
    }, "第二轮圆桌讨论未完成");

    const followUp = detail.messages.find((message) => message.kind === "question" && message.content.includes("动态工具发现"));
    assert.ok(followUp);
    assert.equal(followUp.metadata.target, "all");
    assert.equal(calls.slice(7, 10).every((call) => call.prompt.includes("补充比较状态机和动态工具发现")), true);

    harness.service.respond(topic.id, { content: "Cursor 单独说明迁移成本", target: "cursor" });
    detail = await waitFor(() => {
      const value = harness.service.get(topic.id);
      return calls.length === 15 && value?.topic.status === "completed" ? value : null;
    }, "Cursor 定向回应未完成");
    assert.equal(calls.at(-1).agent, "cursor");
    assert.equal(calls.at(-1).phase, "followup");
    assert.match(calls.at(-1).prompt, /群聊的精简历史/);

    harness.service.respond(topic.id, { content: "先总结当前分歧和下一步", target: "moderator" });
    detail = await waitFor(() => {
      const value = harness.service.get(topic.id);
      return calls.length === 16 && value?.topic.status === "completed" ? value : null;
    }, "主持人定向总结未完成");
    assert.equal(calls.at(-1).agent, "codex");
    assert.equal(calls.at(-1).phase, "summary");
    assert.match(calls.at(-1).prompt, /匿名参与者 A/);
    assert.doesNotMatch(calls.at(-1).prompt, /\nCodex：|\nCursor：|\nMiniMax：/);
    const moderatorSummary = [...detail.messages].reverse().find((item) => item.kind === "summary");
    assert.equal(moderatorSummary.author, "主持人");
    assert.equal(moderatorSummary.role, "moderator");
  } finally {
    harness.close();
  }
});

test("stops an active discussion through AbortSignal and records cancellation", async () => {
  const calls = [];
  let completeImmediately = false;
  const agentRunner = {
    run(agent, input) {
      calls.push({ agent, ...input });
      if (completeImmediately) return Promise.resolve({ text: `${agent} 重试成功 https://example.com/retry`, model: `${agent}-test` });
      return new Promise((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (input.signal.aborted) abort();
        else input.signal.addEventListener("abort", abort, { once: true });
      });
    },
  };
  const harness = createHarness(agentRunner);
  try {
    const topic = harness.service.create({ prompt: "执行一个需要停止的长讨论", cwd: harness.sandbox });
    await waitFor(() => calls.length === 3);
    const cancelling = harness.service.cancel(topic.id);
    assert.equal(cancelling.status, "cancelled");
    assert.equal(cancelling.phase, "cancelling");
    assert.equal(calls.every((call) => call.signal.aborted), true);

    const detail = await waitFor(() => {
      const value = harness.service.get(topic.id);
      return value?.topic.phase === "cancelled" ? value : null;
    });
    assert.equal(detail.topic.status, "cancelled");
    assert.equal(detail.messages.some((message) => message.role === "moderator" && message.content === "讨论已停止。"), true);
    assert.throws(() => harness.service.cancel(topic.id), (error) => error.status === 409);

    completeImmediately = true;
    const retried = harness.service.retry(topic.id);
    assert.equal(retried.status, "running");
    await waitFor(() => harness.service.get(topic.id)?.topic.status === "completed", "停止后的重试未完成");
    assert.equal(calls.length, 10, "cancelled research plus a complete seven-call retry are expected");
    assert.throws(() => harness.service.retry(topic.id), (error) => error.status === 409);
  } finally {
    harness.close();
  }
});

test("validates topic paths and user messages before starting agents", () => {
  const calls = [];
  const harness = createHarness(completedRunner(calls));
  try {
    assert.throws(() => harness.service.create({ prompt: "", cwd: harness.sandbox }), (error) => error.status === 400 && /议题/.test(error.message));
    assert.throws(() => harness.service.create({ prompt: "有效议题", cwd: "relative/path" }), (error) => error.status === 400 && /绝对/.test(error.message));
    assert.throws(() => harness.service.create({ prompt: "有效议题", cwd: join(harness.sandbox, "missing") }), (error) => error.status === 400 && /不存在/.test(error.message));

    const topic = harness.service.create({ prompt: "有效议题", cwd: harness.sandbox });
    assert.throws(() => harness.service.respond(topic.id, { content: "   " }), (error) => error.status === 400 && /请输入消息/.test(error.message));
  } finally {
    harness.close();
  }
});

test("retries a transient agent failure once before publishing its result", async () => {
  const attempts = new Map();
  const harness = createHarness({
    async run(agent, input) {
      const key = `${agent}:${input.phase}`;
      const count = (attempts.get(key) || 0) + 1;
      attempts.set(key, count);
      if (agent === "minimax" && input.phase === "research" && count === 1) throw new Error("temporary gateway failure");
      return { text: `${agent} ${input.phase} result`, model: `${agent}-test` };
    },
  });
  try {
    const topic = harness.service.create({ prompt: "验证自动重试", cwd: harness.sandbox });
    const detail = await waitFor(() => {
      const value = harness.service.get(topic.id);
      return value?.topic.status === "completed" ? value : null;
    });
    assert.equal(attempts.get("minimax:research"), 2);
    assert.equal(detail.messages.some((message) => message.content.includes("首次调用失败，正在自动重试")), true);
    assert.equal(detail.messages.some((message) => message.author === "MiniMax" && message.kind === "analysis"), true);
    assert.equal(detail.messages.some((message) => message.author === "MiniMax" && message.kind === "error"), false);
  } finally {
    harness.close();
  }
});
