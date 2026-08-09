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
    const result = await launcher.launch({ cwd: sandbox, prompt: "frozen envelope", onThreadReady(value) { ready = value; } });
    assert.deepEqual(ready, { threadId: "thread-created", resumed: false });
    assert.deepEqual(result, { threadId: "thread-created", turnId: "turn-created", resumed: false, deepLink: "codex://threads/thread-created" });
    const requests = messages(log);
    assert.deepEqual(requests.map((entry) => entry.method), ["initialize", "initialized", "thread/start", "turn/start"]);
    assert.equal(requests.at(-1).params.input[0].text, "frozen envelope");
    assert.equal(requests.at(-1).params.cwd, sandbox);
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
