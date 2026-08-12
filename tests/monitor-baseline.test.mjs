import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { effectiveLane, initMetadata } from "../server/index.mjs";

function metadata(overrides = {}) {
  return {
    lane: "inbox",
    lastSeenCompletion: null,
    lastSeenInterruption: null,
    reviewTrackingStartedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function thread(overrides = {}) {
  return {
    runtimeStatus: "idle",
    archived: false,
    lastCompletedAt: null,
    lastInterruptedAt: null,
    ...overrides,
  };
}

test("keeps the baseline lane precedence for runtime, review, and manual acknowledgement", () => {
  assert.equal(effectiveLane(thread({ runtimeStatus: "active" }), metadata({ lane: "completed" })), "in_progress");
  assert.equal(effectiveLane(thread({ runtimeStatus: "waiting" }), metadata({ lane: "completed" })), "in_progress");
  assert.equal(effectiveLane(thread({ archived: true }), metadata({ lane: "review" })), "completed");

  const completedAt = "2026-08-02T00:00:00.000Z";
  assert.equal(effectiveLane(thread({ lastCompletedAt: completedAt }), metadata()), "review");
  assert.equal(effectiveLane(thread({ lastCompletedAt: completedAt }), metadata({ lane: "completed", lastSeenCompletion: completedAt })), "completed");

  const interruptedAt = "2026-08-03T00:00:00.000Z";
  assert.equal(effectiveLane(thread({ runtimeStatus: "interrupted", lastInterruptedAt: interruptedAt }), metadata()), "review");
  assert.equal(effectiveLane(thread({ runtimeStatus: "interrupted", lastInterruptedAt: interruptedAt }), metadata({ lane: "completed", lastSeenInterruption: interruptedAt })), "completed");
});

test("upgrades the legacy monitor schema without losing existing task data", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "codex-monitor-baseline-"));
  const databasePath = join(sandbox, "monitor.db");
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      CREATE TABLE thread_metadata (
        thread_id TEXT PRIMARY KEY,
        lane TEXT NOT NULL,
        project_override TEXT,
        tags TEXT NOT NULL,
        priority TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        hidden INTEGER NOT NULL,
        note TEXT NOT NULL,
        completed_at TEXT,
        last_seen_completion TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE manual_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        note TEXT NOT NULL,
        lane TEXT NOT NULL,
        project TEXT,
        tags TEXT NOT NULL,
        priority TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        codex_thread_id TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO thread_metadata
        (thread_id,lane,project_override,tags,priority,sort_order,hidden,note,completed_at,last_seen_completion,updated_at)
      VALUES
        ('thread-legacy','completed','legacy','["old"]','high',3,0,'keep thread note','2026-07-01T00:00:00.000Z','2026-07-01T00:00:00.000Z','2026-07-01T01:00:00.000Z');
      INSERT INTO manual_tasks
        (id,title,note,lane,project,tags,priority,sort_order,codex_thread_id,completed_at,created_at,updated_at)
      VALUES
        ('manual-legacy','保留旧任务','keep manual note','upcoming','legacy','["old"]','high',4,NULL,NULL,'2026-07-01T00:00:00.000Z','2026-07-01T01:00:00.000Z');
    `);

    initMetadata(db);

    const metadataColumns = new Set(db.prepare("PRAGMA table_info(thread_metadata)").all().map((column) => column.name));
    const manualColumns = new Set(db.prepare("PRAGMA table_info(manual_tasks)").all().map((column) => column.name));
    for (const column of ["pinned", "last_seen_interruption", "review_tracking_started_at"]) assert.equal(metadataColumns.has(column), true);
    for (const column of ["cwd", "pinned", "launch_requested_at"]) assert.equal(manualColumns.has(column), true);

    const legacyThread = db.prepare("SELECT * FROM thread_metadata WHERE thread_id='thread-legacy'").get();
    const legacyTask = db.prepare("SELECT * FROM manual_tasks WHERE id='manual-legacy'").get();
    assert.equal(legacyThread.note, "keep thread note");
    assert.equal(legacyThread.review_tracking_started_at, "2026-07-01T01:00:00.000Z");
    assert.equal(legacyThread.pinned, 0);
    assert.equal(legacyTask.title, "保留旧任务");
    assert.equal(legacyTask.note, "keep manual note");
    assert.equal(legacyTask.cwd, null);
    assert.equal(legacyTask.pinned, 0);
    assert.equal(legacyTask.launch_requested_at, null);
  } finally {
    db.close();
    rmSync(sandbox, { recursive: true, force: true });
  }
});
