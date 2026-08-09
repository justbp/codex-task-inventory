# M2 收口：Codex Execution Bridge

## 1. 目标与边界

本次把已经实现的 Work Item、Readiness、Context Envelope 和 Run 快照连接到真实 Codex App Server。它提供 API 级启动与恢复能力，不新增或修改现有看板视图，也不提前实现 M3 的结构化回写、Decision Request 或人工验收闭环。

保护的不变量：`I-01`～`I-13`、`I-15`。本次没有引入 WIP 决策，因此不改变 `I-14`。

## 2. 真实执行链

`POST /api/work-items/:id/start` 按以下顺序执行：

1. 校验 `expectedVersion`、工作目录和 Readiness。
2. 从 Work Item 及其附属事实重新生成 Context Envelope。
3. 先把冻结 Envelope 和 `queued` Run 持久化。
4. 原子认领启动权，防止同一 Run 被并发启动。
5. 默认恢复该 Work Item 最近绑定的 Codex thread；`threadStrategy=new` 时创建新 thread。
6. 通过 Codex App Server 执行 `thread/start` 或 `thread/resume`，随后执行 `turn/start`。
7. 在 Run 上持久化真实 thread ID、turn ID 和启动结果。

发给 Codex 的文本包含冻结 Envelope，并明确 Work Item 是真相源、不得依赖旧对话扩大范围、不得自行把任务标记为完成。

## 3. API

```http
POST /api/work-items/:id/start
Content-Type: application/json

{
  "idempotencyKey": "start-work-item-42-v3",
  "expectedVersion": 3,
  "mode": "implementation",
  "threadStrategy": "continue",
  "objective": "完成当前唯一下一步",
  "expectedOutput": "实现结果和验证证据"
}
```

- `mode`：`implementation`（默认）或 `explore`。
- `threadStrategy`：`continue`（默认）或 `new`。
- 首次成功返回 `201`；相同幂等请求重放返回 `200` 和同一个 Run，不会再次调用 Codex。
- `POST /api/work-items/:id/runs` 仍保留为只创建逻辑 Run/快照的兼容接口。

## 4. 启动状态与故障语义

Run 新增独立的 `launchState`：

- `not_requested`：逻辑 Run 或旧数据，没有请求真实启动。
- `pending`：Run 已落库，等待认领。
- `launching`：已认领，正在调用 App Server。
- `started`：thread 和 turn 均已绑定。
- `failed`：可确认未获得 thread。
- `uncertain`：已经获得 thread，但后续通信失败，外部结果可能已发生。

Codex App Server 的 `thread/start` 没有业务幂等键，因此系统不会自动重试 `failed` 或 `uncertain` Run。尤其 `uncertain` 必须先检查已绑定 task，再由用户用新的幂等键决定是否创建新 Run。这是在无法提供跨进程严格 exactly-once 时避免重复执行的安全边界。

`launchState` 与 Run Status、Work Status 分离。启动成功只把 Run 置为 `running`，不会隐式修改 Work Item，更不会置为 `done`。

## 5. 验证

- Codex App Server 协议测试覆盖 `initialize → thread/start → turn/start` 和 `initialize → thread/resume → turn/start`。
- API 集成测试覆盖冻结 Envelope、真实 ID 绑定、默认恢复、新 thread、幂等重放、启动失败和不确定结果。
- M0 看板监控、M1 模型和原 M2 上下文测试保持通过。
