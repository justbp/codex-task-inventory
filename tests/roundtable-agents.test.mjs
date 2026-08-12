import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createRoundtableAgentRunner } from "../server/roundtable-agents.mjs";

function fakeSpawnFor(lines, { code = 0, stderr = "" } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 99_999;
    child.killed = false;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = (input) => { child.stdinInput = input; };
    child.kill = (signal) => { child.killed = true; child.killSignal = signal; return true; };
    calls.push({ command, args, options, child });
    queueMicrotask(() => {
      for (const line of lines) child.stdout.emit("data", Buffer.from(`${JSON.stringify(line)}\n`));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", code, null);
    });
    return child;
  };
  return { spawnImpl, calls };
}

test("runs Codex with read-only ephemeral JSONL flags and parses its final message", async () => {
  const fake = fakeSpawnFor([
    { type: "thread.started", thread_id: "codex-session" },
    { type: "item.completed", item: { type: "agent_message", text: "Codex 结论" } },
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 4 } },
  ]);
  const events = [];
  const runner = createRoundtableAgentRunner({ spawnImpl: fake.spawnImpl, models: { codex: "codex-test" } });
  const result = await runner.run("codex", {
    cwd: "/tmp/project",
    prompt: "检查架构",
    phase: "research",
    onEvent: (event) => events.push(event),
  });

  const call = fake.calls[0];
  assert.match(call.command, /(?:^|\/)codex$/);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.detached, true);
  assert.deepEqual(call.args.slice(0, 9), [
    "--search", "exec", "--ignore-user-config", "--ephemeral", "--sandbox", "read-only",
    "--skip-git-repo-check", "--json", "--color",
  ]);
  assert.ok(call.args.includes("codex-test"));
  assert.match(call.child.stdinInput, /题设中的评价只是待验证假设/);
  assert.match(call.child.stdinInput, /不套固定报告模板/);
  assert.doesNotMatch(call.child.stdinInput, /依次包含：初步判断/);
  assert.match(call.child.stdinInput, /检查架构/);
  assert.equal(result.text, "Codex 结论");
  assert.equal(result.sessionId, "codex-session");
  assert.equal(events.filter((event) => event.type === "text_delta").length, 1);
});

test("uses Cursor ask+sandbox mode and does not duplicate partial and final text", async () => {
  const fake = fakeSpawnFor([
    { type: "system", subtype: "init", session_id: "cursor-session", model: "Cursor Test" },
    { type: "assistant", timestamp_ms: 1, message: { content: [{ type: "text", text: "增量" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "完整回答" }] } },
    { type: "result", subtype: "success", is_error: false, result: "最终回答", usage: { outputTokens: 8 } },
  ]);
  const events = [];
  const runner = createRoundtableAgentRunner({ spawnImpl: fake.spawnImpl });
  const result = await runner.run("cursor", {
    cwd: "/tmp/project",
    prompt: "寻找反例",
    onEvent: (event) => events.push(event),
  });

  const { args, options } = fake.calls[0];
  assert.equal(options.shell, false);
  assert.ok(args.includes("ask"));
  assert.ok(args.includes("enabled"));
  assert.ok(!args.includes("--force"));
  assert.ok(!args.includes("--yolo"));
  assert.equal(result.text, "最终回答");
  assert.equal(result.model, "Cursor Test");
  assert.deepEqual(events.filter((event) => event.type === "text_delta").map((event) => event.text), ["增量"]);
});

test("uses Claude safe mode with read-only repository and web research for MiniMax", async () => {
  const substantiveAnswer = "这个议题可以先质疑两个默认前提。第一，维护困难未必来自工具数量，而可能来自协议所有权分散；可通过追踪同一业务不变量涉及的文件和层次来证伪。第二，更强的模型未必能降低高风险流程成本，因为提交授权、幂等和版本一致性仍需确定性协议；可用同一批故障回放比较受限 Agent 与自由 Agent。还应保留一个反常识方向：减少自动猜测，在高风险歧义处主动询问用户，并比较额外轮次与误操作成本。";
  const fake = fakeSpawnFor([
    { type: "system", subtype: "init", session_id: "mini-session", model: "MiniMax-M3" },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hidden" } } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Mini" } } },
    { type: "assistant", message: { content: [{ type: "text", text: substantiveAnswer }] } },
    { type: "result", subtype: "success", is_error: false, result: substantiveAnswer, usage: { output_tokens: 90 } },
  ]);
  const events = [];
  const runner = createRoundtableAgentRunner({ spawnImpl: fake.spawnImpl, homeDir: "/Users/test" });
  const result = await runner.run("minimax", {
    cwd: "/tmp/project",
    prompt: "搜索论文",
    onEvent: (event) => events.push(event),
  });

  const { args } = fake.calls[0];
  assert.ok(args.includes("--safe-mode"));
  assert.ok(args.includes("/Users/test/.claude/settings.json"));
  assert.ok(args.includes("Read,Grep,Glob,WebSearch,WebFetch"));
  assert.ok(args.includes("--allowedTools"));
  assert.ok(args.includes("Edit,Write,NotebookEdit,Bash,Task"));
  assert.ok(args.includes("auto"));
  assert.ok(!args.includes("plan"));
  assert.ok(!args.includes("--max-budget-usd"));
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  assert.match(args.at(-1), /企业级方案与反常识探索席位/);
  assert.match(args.at(-1), /允许使用 WebSearch\/WebFetch/);
  assert.match(args.at(-1), /直接输出对议题有实质内容的中文观点/);
  assert.equal(result.text, substantiveAnswer);
  assert.deepEqual(events.filter((event) => event.type === "text_delta").map((event) => event.text), ["Mini"]);
});

test("preserves Claude structured errors when MiniMax exits non-zero", async () => {
  const fake = fakeSpawnFor([
    {
      type: "result",
      subtype: "error_max_budget_usd",
      is_error: true,
      terminal_reason: "budget_exhausted",
      errors: ["Reached maximum budget ($0.50)"],
      permission_denials: [{ tool_name: "WebSearch" }],
    },
  ], { code: 1 });
  const runner = createRoundtableAgentRunner({ spawnImpl: fake.spawnImpl, homeDir: "/Users/test" });

  await assert.rejects(runner.run("minimax", {
    cwd: "/tmp/project",
    prompt: "检索企业 Agent",
    phase: "research",
  }), (error) => {
    assert.equal(error.code, "ROUND_TABLE_AGENT_FAILED");
    assert.match(error.message, /error_max_budget_usd/);
    assert.match(error.message, /budget_exhausted/);
    assert.match(error.message, /Reached maximum budget/);
    assert.match(error.message, /WebSearch/);
    return true;
  });
});

test("rejects MiniMax process narration so the orchestrator can retry", async () => {
  const fake = fakeSpawnFor([
    { type: "system", subtype: "init", session_id: "mini-session", model: "MiniMax-M3" },
    { type: "result", subtype: "success", is_error: false, result: "我先把这一轮概念探索写入计划文件，然后提交。", usage: { output_tokens: 1000 } },
  ]);
  const runner = createRoundtableAgentRunner({ spawnImpl: fake.spawnImpl, homeDir: "/Users/test" });

  await assert.rejects(runner.run("minimax", {
    cwd: "/tmp/project",
    prompt: "挑战审批 Agent 的架构前提",
    phase: "research",
  }), { code: "ROUND_TABLE_LOW_QUALITY" });
});

test("aborts a running child and distinguishes cancellation from failure", async () => {
  let child;
  const spawnImpl = () => {
    child = new EventEmitter();
    child.pid = 99_998;
    child.killed = false;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => {};
    child.kill = (signal) => { child.killed = true; child.killSignal = signal; return true; };
    return child;
  };
  const controller = new AbortController();
  const runner = createRoundtableAgentRunner({ spawnImpl, timeouts: { killGrace: 1 } });
  const pending = runner.run("cursor", {
    cwd: "/tmp/project",
    prompt: "长任务",
    signal: controller.signal,
  });
  controller.abort();

  await assert.rejects(pending, (error) => error.name === "AbortError" && error.code === "ROUND_TABLE_ABORTED");
  assert.equal(child.killSignal, "SIGTERM");
});

test("times out and escalates from SIGTERM to SIGKILL when a child will not exit", async () => {
  let child;
  const signals = [];
  const spawnImpl = () => {
    child = new EventEmitter();
    child.pid = 99_997;
    child.killed = false;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => {};
    child.kill = (signal) => { signals.push(signal); return true; };
    return child;
  };
  const runner = createRoundtableAgentRunner({
    spawnImpl,
    timeouts: { research: 5, killGrace: 5 },
  });

  await assert.rejects(runner.run("codex", {
    cwd: "/tmp/project",
    prompt: "不会完成的任务",
  }), { code: "ROUND_TABLE_TIMEOUT" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("rejects unsupported agents and relative workspaces before spawning", async () => {
  const runner = createRoundtableAgentRunner({ spawnImpl: () => { throw new Error("should not spawn"); } });
  await assert.rejects(runner.run("other", { cwd: "/tmp/project", prompt: "x" }), { code: "ROUND_TABLE_BAD_AGENT" });
  await assert.rejects(runner.run("codex", { cwd: "relative", prompt: "x" }), { code: "ROUND_TABLE_BAD_CWD" });
});
