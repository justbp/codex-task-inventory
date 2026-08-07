import { spawn } from "node:child_process";

const NOTIFICATION_SCRIPT = `
on run argv
  set notificationBody to item 1 of argv
  set notificationTitle to item 2 of argv
  set notificationSubtitle to item 3 of argv
  display notification notificationBody with title notificationTitle subtitle notificationSubtitle sound name "Glass"
end run
`;

export class MacOSNotifier {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.enabled = options.enabled ?? process.env.TASKBOARD_NOTIFICATIONS !== "0";
    this.command = options.command || "/usr/bin/osascript";
    this.spawn = options.spawn || spawn;
  }

  async notify({ title, subtitle = "Codex Task Monitor", body }) {
    if (!this.enabled) return { delivered: false, reason: "macOS 通知已被配置关闭" };
    if (this.platform !== "darwin") return { delivered: false, reason: "系统通知目前仅支持 macOS" };

    return new Promise((resolve, reject) => {
      const child = this.spawn(this.command, ["-e", NOTIFICATION_SCRIPT, "--", String(body), String(title), String(subtitle)], {
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve({ delivered: true });
        else reject(new Error(`osascript 退出码：${code}`));
      });
    });
  }

  notifyReview(thread) {
    return this.notify({
      title: "Codex 任务待 Review",
      subtitle: thread.project || "Codex Task Monitor",
      body: thread.title || "一个 Codex 任务已结束",
    });
  }
}
