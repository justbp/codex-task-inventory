import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
