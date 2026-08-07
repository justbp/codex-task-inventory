# Codex Task Monitor

本机运行的 Codex 任务盘点看板。你可以先在收集箱和待办列里挂自己的事项；进入执行阶段后，由真实 Codex 对话提供运行状态和进展。

M0～M2 的完整功能、验证结果和当前产品边界见 [`docs/RELEASE_NOTES_M0_M2.md`](docs/RELEASE_NOTES_M0_M2.md)。Work Item、Run 和上下文管理目前提供后端模型与 API，尚未增加对应网页表单或自动 Codex 对话集成。

## 工作方式

- 从 `~/.codex/state_5.sqlite` 只读获取 Codex 任务列表，并通过 App Server 的 `thread/read` 同步用户可见名称。
- 从每个任务的 rollout JSONL 只读获取开始、完成、中断、最近进展和文件修改事件。
- 每两秒检查一次文件是否变化，变化后通过 SSE 通知浏览器刷新。
- 任务从“进行中”进入“待 Review”时，由常驻服务通过 macOS 通知中心提醒；首次启动只建立状态基线，不会为已有待 Review 任务补发通知。
- 通过 Codex App Server 的 `account/rateLimits/read` 读取当前额度窗口，在顶部展示剩余百分比和刷新时间；结果缓存一分钟，避免频繁请求。
- 卡片使用 `codex://threads/{threadId}` 回到对应 Codex 对话。
- Codex 对话名称只读同步；请在 Codex 中改名，看板不提供改名入口。
- 当前页面兼容层在本地 `data/monitor.db` 保存项目覆盖、标签、优先级、排布、隐藏、备注和完成确认；Workbench 领域层另行保存 Work Item、Run、版本化上下文、恢复点、证据引用和审计记录。
- 收集箱、待办列只展示手工事项，不再灌入历史 Codex 对话。
- 待办列中的事项填写工作目录后，可在详情中点击“打开 Codex”；服务会使用该目录创建并启动真实 Codex 对话，然后把原手工待办绑定到该对话，不会在看板中留下重复卡片。
- 项目和工作目录支持从已识别的 Codex 任务中下拉选择；选择项目会自动带出已有目录，也可继续手动输入新值。
- 已完成任务集中到独立的 `/completed` 页面，支持今天、本周、本月和全部筛选。
- 待 Review 支持全选和批量通过。

看板不直接读取或暴露 Codex 登录凭据。额度查询和“打开 Codex”都通过本机 Codex App Server 完成；后者会创建对话并发送待办标题和说明，因此会开始实际执行并产生相应 Token 消耗。

## 状态规则

| 看板列 | 规则 |
| --- | --- |
| 收集箱 | 你手工挂起、尚未准备处理的待办 |
| 待办 | 已准备好，可交给 Codex 处理的手工事项 |
| 进行中 | Codex 当前存在未完成 turn；等待用户时显示“等待我” |
| 待 Review | 新一轮完成或任务中断，等待检查 |
| 已完成页面 | 用户确认完成，或 Codex 对话已归档 |

运行态优先于手工排布：任务执行时一定显示在“进行中”。
首次执行完成会进入“待 Review”；人工通过后记录本次完成时间，同一任务后续再次完成时会重新进入“待 Review”。
中断任务也遵循相同规则：人工通过会确认当前中断，只有发生新的中断才会再次进入“待 Review”。

## 启动

需要 Node.js 22.13 或更高版本。

```bash
npm install
npm run dev
```

访问 <http://127.0.0.1:47824>。

```bash
npm test
npm run lint
```

### macOS 常驻运行

仓库中的 `ops/local.codex-task-inventory.plist.example` 是用户级 `launchd` 模板。复制到 `~/Library/LaunchAgents/local.codex-task-inventory.plist` 前，请将 `__NODE_BINARY__`、`__NODE_BIN_DIR__`、`__PROJECT_DIR__` 和 `__HOME_DIR__` 替换为本机绝对路径。服务登录时自动启动、异常退出后自动拉起，日志位于 `~/Library/Logs/CodexTaskInventory/`。

顶部铃铛按钮可立即发送一条测试通知。通知使用 macOS 自带的 AppleScript `display notification`，不依赖额外软件，因此看板页面关闭后，只要 `launchd` 服务仍在运行也可以收到。显示方式和声音由“系统设置 → 通知”控制；勿扰/专注模式可能延迟或隐藏横幅。若要关闭服务端通知，在 plist 的 `EnvironmentVariables` 中加入 `TASKBOARD_NOTIFICATIONS=0` 后重新加载服务。

## Codex 任务绑定

启动待办时，服务通过本机 Codex App Server 取得真实 `threadId`，把手工待办的项目、标签、优先级、排序、置顶和备注迁移到该线程，并将原手工记录标记为已绑定。看板之后只展示真实 Codex 线程，卡片会随运行态进入“进行中”和“待 Review”。
