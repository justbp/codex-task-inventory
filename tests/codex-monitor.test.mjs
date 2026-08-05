import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CodexMonitor } from "../server/codex-monitor.mjs";

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
