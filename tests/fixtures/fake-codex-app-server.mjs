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
    write({ method: "item/completed", params: { threadId: message.params.threadId, turnId: "turn-created", item: { type: "agentMessage", id: "message-final", phase: "final_answer", text: "## 已完成\n协议测试完成\n\n## 验证结果\nthread 与 turn 已绑定\n\n## 风险\n无\n\n## 需要用户决定\n无\n\n## 下一步\n等待人工验收" } } });
    return write({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: "turn-created", status: "completed" } } });
  }
  write({ id: message.id, error: { message: `unsupported ${message.method}` } });
});
