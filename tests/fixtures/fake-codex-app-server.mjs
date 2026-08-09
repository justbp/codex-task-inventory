import { appendFileSync } from "node:fs";
import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify(message)}\n`);
  if (message.id === undefined) return;
  if (message.method === "initialize") return write({ id: message.id, result: { userAgent: "fake-codex" } });
  if (message.method === "thread/start") return write({ id: message.id, result: { thread: { id: "thread-created" } } });
  if (message.method === "thread/resume") return write({ id: message.id, result: { thread: { id: message.params.threadId } } });
  if (message.method === "turn/start") {
    write({ id: message.id, result: { turn: { id: "turn-created" } } });
    return write({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: "turn-created", status: "completed" } } });
  }
  write({ id: message.id, error: { message: `unsupported ${message.method}` } });
});
