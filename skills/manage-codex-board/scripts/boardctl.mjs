#!/usr/bin/env node

import { createHash } from "node:crypto";

const DEFAULT_BASE_URL = "http://127.0.0.1:47824";
const DEFAULT_LIMIT = 12;

function compact(value, limit = 180) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function newestFirst(left, right) {
  return String(right.lastProgressAt || right.updatedAt || "").localeCompare(String(left.lastProgressAt || left.updatedAt || ""));
}

function progressAgeBand(task, now) {
  if (task.runtimeStatus !== "active") return null;
  const lastProgressAt = Date.parse(task.lastProgressAt || task.activeStartedAt || task.updatedAt || "");
  if (!Number.isFinite(lastProgressAt)) return "unknown";
  return now.getTime() - lastProgressAt >= 60 * 60 * 1000 ? "over_60m" : "under_60m";
}

function buildAttentionToken(items, now) {
  const state = items
    .filter((item) => item.lane !== "completed")
    .map((item) => ({
      id: item.id,
      lane: item.lane,
      runtimeStatus: item.runtimeStatus,
      priority: item.priority || "medium",
      resultAt: item.lastCompletedAt || item.lastInterruptedAt || null,
      needsUserAt: ["waiting", "interrupted"].includes(item.runtimeStatus) ? item.lastProgressAt || item.updatedAt || null : null,
      activeAgeBand: progressAgeBand(item, now),
    }))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  return createHash("sha256").update(JSON.stringify(state)).digest("hex").slice(0, 16);
}

function taskView(task) {
  return {
    id: task.id,
    title: compact(task.title, 180),
    kind: task.kind,
    lane: task.lane,
    runtimeStatus: task.runtimeStatus,
    project: compact(task.project, 100),
    cwd: compact(task.cwd, 500),
    priority: task.priority || "medium",
    updatedAt: task.updatedAt || null,
    activeStartedAt: task.activeStartedAt || null,
    lastProgressAt: task.lastProgressAt || null,
    lastCompletedAt: task.lastCompletedAt || null,
    lastInterruptedAt: task.lastInterruptedAt || null,
    progress: compact(task.lastProgress || task.preview, 180),
    lastError: compact(task.lastError, 180),
    deepLink: compact(task.deepLink, 500) || null,
  };
}

export function buildSnapshot(threads, limit = DEFAULT_LIMIT, now = new Date()) {
  const items = Array.isArray(threads) ? threads : [];
  const take = (predicate) => items.filter(predicate).sort(newestFirst).slice(0, limit).map(taskView);
  return {
    generatedAt: now.toISOString(),
    attentionToken: buildAttentionToken(items, now),
    counts: {
      total: items.length,
      waiting: items.filter((item) => item.runtimeStatus === "waiting").length,
      active: items.filter((item) => item.runtimeStatus === "active").length,
      interrupted: items.filter((item) => item.runtimeStatus === "interrupted" && item.lane !== "completed").length,
      review: items.filter((item) => item.lane === "review").length,
      upcoming: items.filter((item) => item.kind === "manual" && item.lane === "upcoming").length,
      inbox: items.filter((item) => item.kind === "manual" && item.lane === "inbox").length,
    },
    waiting: take((item) => item.runtimeStatus === "waiting"),
    interrupted: take((item) => item.runtimeStatus === "interrupted" && item.lane !== "completed"),
    review: take((item) => item.lane === "review" && !["waiting", "active"].includes(item.runtimeStatus)),
    active: take((item) => item.runtimeStatus === "active"),
    upcoming: take((item) => item.kind === "manual" && item.lane === "upcoming"),
    inbox: take((item) => item.kind === "manual" && item.lane === "inbox"),
  };
}

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function required(options, key) {
  const value = compact(options[key], key === "cwd" ? 1000 : 4000);
  if (!value) throw new Error(`Missing required option --${key}`);
  return value;
}

async function request(baseUrl, path, options = {}, fetchImpl = fetch) {
  const response = await fetchImpl(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(body?.error || body?.message || `Board request failed (${response.status})`);
  return body;
}

function taskInput(options, lane) {
  return {
    title: required(options, "title"),
    note: compact(options.note, 4000),
    project: compact(options.project, 120),
    cwd: compact(options.cwd, 1000),
    lane,
  };
}

function adviceInput(options) {
  return {
    attentionToken: required(options, "attention-token"),
    headline: required(options, "headline"),
    focus: required(options, "focus"),
    background: compact(options.background, 400),
    after: compact(options.after, 400),
    parked: compact(options.parked, 400),
    nextCheck: compact(options["next-check"], 200),
    risk: compact(options.risk, 300),
    primaryTaskId: compact(options["primary-task-id"], 100) || null,
    generatedAt: compact(options["generated-at"], 50) || new Date().toISOString(),
  };
}

export async function run(argv, { fetchImpl = fetch, baseUrl = process.env.CODEX_TASK_MONITOR_URL || DEFAULT_BASE_URL } = {}) {
  const { command, options } = parseArgs(argv);
  if (command === "snapshot") {
    const result = await request(baseUrl, "/api/threads", {}, fetchImpl);
    const parsedLimit = Number.parseInt(options.limit || "", 10);
    return buildSnapshot(result?.threads, Number.isSafeInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 30) : DEFAULT_LIMIT);
  }
  if (command === "create") {
    const lane = options.lane || "inbox";
    if (!["inbox", "upcoming"].includes(lane)) throw new Error("--lane must be inbox or upcoming");
    return request(baseUrl, "/api/items", { method: "POST", body: JSON.stringify(taskInput(options, lane)) }, fetchImpl);
  }
  if (command === "start") {
    const id = required(options, "id");
    return request(baseUrl, `/api/items/${encodeURIComponent(id)}/start`, { method: "POST", body: "{}" }, fetchImpl);
  }
  if (command === "dispatch") {
    required(options, "cwd");
    const created = await request(baseUrl, "/api/items", { method: "POST", body: JSON.stringify(taskInput(options, "upcoming")) }, fetchImpl);
    const id = created?.item?.id;
    if (!id) throw new Error("Board did not return a created item id");
    const launched = await request(baseUrl, `/api/items/${encodeURIComponent(id)}/start`, { method: "POST", body: "{}" }, fetchImpl);
    return { item: created.item, launched };
  }
  if (command === "publish-advice") {
    return request(baseUrl, "/api/attention-advice", { method: "PUT", body: JSON.stringify(adviceInput(options)) }, fetchImpl);
  }
  return {
    usage: [
      "boardctl.mjs snapshot [--limit 12]",
      "boardctl.mjs create --title TITLE [--note NOTE] [--project PROJECT] [--cwd PATH] [--lane inbox|upcoming]",
      "boardctl.mjs start --id ID",
      "boardctl.mjs dispatch --title TITLE --cwd PATH [--note NOTE] [--project PROJECT]",
      "boardctl.mjs publish-advice --attention-token TOKEN --headline TEXT --focus TEXT [--background TEXT] [--after TEXT] [--parked TEXT] [--next-check TEXT] [--risk TEXT] [--primary-task-id ID]",
    ],
  };
}

const invokedDirectly = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (invokedDirectly) {
  run(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
