import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CodexLauncher } from "../server/codex-launcher.mjs";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-codex-app-server.mjs");

function messages(path) {
  return readFileSync(path, "utf8").trim().split("\n").map(JSON.parse);
}

test("CodexLauncher starts a thread, binds it, then starts a turn", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "codex-launcher-"));
  const log = join(sandbox, "messages.jsonl");
  const launcher = new CodexLauncher({ command: process.execPath, commandArgs: [fixture], env: { FAKE_CODEX_LOG: log } });
  try {
    let ready;
    let turnStarted;
    let resolveCompletion;
    const completion = new Promise((resolve) => { resolveCompletion = resolve; });
    const result = await launcher.launch({
      cwd: sandbox,
      prompt: "frozen envelope",
      onThreadReady(value) { ready = value; },
      onTurnStarted(value) { turnStarted = value; },
      onTurnCompleted(value) { resolveCompletion(value); },
    });
    assert.deepEqual(ready, { threadId: "thread-created", resumed: false });
    assert.deepEqual(turnStarted, { threadId: "thread-created", turnId: "turn-created", resumed: false });
    assert.deepEqual(result, { threadId: "thread-created", turnId: "turn-created", resumed: false, deepLink: "codex://threads/thread-created" });
    const requests = messages(log);
    assert.deepEqual(requests.map((entry) => entry.method), ["initialize", "initialized", "thread/start", "turn/start"]);
    const threadStart = requests.find((entry) => entry.method === "thread/start");
    assert.equal(threadStart.params.sandbox, "workspace-write");
    assert.equal(threadStart.params.approvalPolicy, "on-request");
    assert.equal(requests.at(-1).params.input[0].text, "frozen envelope");
    assert.equal(requests.at(-1).params.cwd, sandbox);
    const completed = await completion;
    assert.equal(completed.threadId, "thread-created");
    assert.equal(completed.turnId, "turn-created");
    assert.equal(completed.status, "completed");
    assert.match(completed.finalMessage, /等待人工验收/);
  } finally {
    launcher.close();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("CodexLauncher can isolate a read-only manager call", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "codex-launcher-read-only-"));
  const log = join(sandbox, "messages.jsonl");
  const launcher = new CodexLauncher({ command: process.execPath, commandArgs: [fixture], env: { FAKE_CODEX_LOG: log } });
  try {
    await launcher.launch({
      cwd: sandbox,
      prompt: "manager envelope",
      sandbox: "read-only",
      approvalPolicy: "never",
    });
    const threadStart = messages(log).find((entry) => entry.method === "thread/start");
    assert.equal(threadStart.params.sandbox, "read-only");
    assert.equal(threadStart.params.approvalPolicy, "never");
  } finally {
    launcher.close();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("CodexLauncher resumes the requested thread before starting a new turn", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "codex-launcher-resume-"));
  const log = join(sandbox, "messages.jsonl");
  const launcher = new CodexLauncher({ command: process.execPath, commandArgs: [fixture], env: { FAKE_CODEX_LOG: log } });
  try {
    const result = await launcher.launch({ cwd: sandbox, prompt: "resume envelope", threadId: "thread-existing" });
    assert.equal(result.threadId, "thread-existing");
    assert.equal(result.resumed, true);
    const requests = messages(log);
    assert.equal(requests.some((entry) => entry.method === "thread/start"), false);
    assert.equal(requests.find((entry) => entry.method === "thread/resume").params.threadId, "thread-existing");
    assert.equal(requests.at(-1).params.threadId, "thread-existing");
  } finally {
    launcher.close();
    rmSync(sandbox, { recursive: true, force: true });
  }
});
