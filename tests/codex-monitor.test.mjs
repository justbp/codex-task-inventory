import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CodexMonitor, normalizeCodexTitle } from "../server/codex-monitor.mjs";

test("derives active, progress, completion, and interruption from rollout events", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-rollout-"));
  const path = join(dir, "rollout.jsonl");
  const lines = [
    { timestamp: "2026-08-03T10:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "one" } },
    { timestamp: "2026-08-03T10:00:01Z", type: "event_msg", payload: { type: "agent_message", message: "正在查询数据" } },
  ];
  writeFileSync(path, lines.map(JSON.stringify).join("\n"));
  const monitor = new CodexMonitor({ statePath: join(dir, "missing.sqlite") });
  assert.equal(monitor.inspectRollout(path).runtimeStatus, "active");
  assert.equal(monitor.inspectRollout(path).lastProgress, "正在查询数据");

  lines.push({ timestamp: "2026-08-03T10:00:02Z", type: "event_msg", payload: { type: "turn_aborted", reason: "用户中断" } });
  writeFileSync(path, lines.map(JSON.stringify).join("\n"));
  assert.equal(monitor.inspectRollout(path).runtimeStatus, "interrupted");
  assert.equal(monitor.inspectRollout(path).lastInterruptedAt, "2026-08-03T10:00:02Z");
  rmSync(dir, { recursive: true, force: true });
});

test("prefers the user-facing Codex name over the generated title", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-state-"));
  const statePath = join(dir, "state.sqlite");
  const db = new DatabaseSync(statePath);
  db.exec("CREATE TABLE threads (id TEXT, name TEXT, title TEXT, preview TEXT, cwd TEXT, source TEXT, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER, is_pinned INTEGER)");
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("thread-1", "FBA 信息缺失原因", "[Image #1] 看下咋处理", "", "/tmp/project", "cli", "", 1, 2, 0, 0);
  db.close();

  const [thread] = new CodexMonitor({ statePath }).list();
  assert.equal(thread.title, "FBA 信息缺失原因");
  rmSync(dir, { recursive: true, force: true });
});

test("filters empty delegated interruptions but keeps delegated work with progress", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-delegation-"));
  const path = join(dir, "rollout.jsonl");
  const delegation = "<codex_delegation><source_thread_id>parent</source_thread_id><input>复核发货计划短装未显示</input></codex_delegation>";
  const lines = [
    { timestamp: "2026-08-03T10:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "one" } },
    { timestamp: "2026-08-03T10:00:01Z", type: "event_msg", payload: { type: "user_message", message: delegation } },
    { timestamp: "2026-08-03T10:00:02Z", type: "event_msg", payload: { type: "turn_aborted", reason: "被接管" } },
  ];
  writeFileSync(path, lines.map(JSON.stringify).join("\n"));
  let result = new CodexMonitor({ statePath: join(dir, "missing.sqlite") }).inspectRollout(path);
  assert.equal(result.latestTerminalOriginKind, "delegation");
  assert.equal(result.latestTerminalReviewEligible, false);

  lines.splice(2, 0, { timestamp: "2026-08-03T10:00:01.500Z", type: "event_msg", payload: { type: "agent_message", message: "已定位到数量差异" } });
  writeFileSync(path, lines.map(JSON.stringify).join("\n"));
  result = new CodexMonitor({ statePath: join(dir, "missing.sqlite") }).inspectRollout(path);
  assert.equal(result.latestTerminalReviewEligible, true);
  rmSync(dir, { recursive: true, force: true });
});

test("filters no-action heartbeats and keeps heartbeat notifications", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-heartbeat-"));
  const path = join(dir, "rollout.jsonl");
  const heartbeat = "<heartbeat><automation_id>datapanel</automation_id></heartbeat>";
  const lines = [
    { timestamp: "2026-08-03T10:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "one" } },
    { timestamp: "2026-08-03T10:00:01Z", type: "event_msg", payload: { type: "user_message", message: heartbeat } },
    { timestamp: "2026-08-03T10:00:02Z", type: "event_msg", payload: { type: "task_complete", last_agent_message: "<heartbeat><decision>DONT_NOTIFY</decision><message>没有新事项</message></heartbeat>" } },
  ];
  writeFileSync(path, lines.map(JSON.stringify).join("\n"));
  let result = new CodexMonitor({ statePath: join(dir, "missing.sqlite") }).inspectRollout(path);
  assert.equal(result.latestTerminalOriginKind, "heartbeat");
  assert.equal(result.latestTerminalReviewEligible, false);

  lines[2].payload.last_agent_message = "<heartbeat><decision>NOTIFY</decision><message>需要重新授权</message></heartbeat>";
  writeFileSync(path, lines.map(JSON.stringify).join("\n"));
  result = new CodexMonitor({ statePath: join(dir, "missing.sqlite") }).inspectRollout(path);
  assert.equal(result.latestTerminalReviewEligible, true);
  rmSync(dir, { recursive: true, force: true });
});

test("normalizes protocol-shaped Codex titles", () => {
  assert.equal(
    normalizeCodexTitle("<codex_delegation>", "<codex_delegation><input>复核发货计划短装未显示</input></codex_delegation>"),
    "委派：复核发货计划短装未显示",
  );
  assert.equal(
    normalizeCodexTitle("<heartbeat>", "<heartbeat><automation_id>datapanel</automation_id></heartbeat>"),
    "定时任务：datapanel",
  );
  assert.equal(normalizeCodexTitle("修复库存差异", "<codex_delegation>"), "修复库存差异");
});
