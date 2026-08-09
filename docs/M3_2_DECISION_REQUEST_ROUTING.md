# M3.2：Decision Request 与原 Run 续跑

## 1. 目标与边界

本子里程碑让执行中的 Codex Run 可以把需要用户判断的问题结构化交给看板，用户回答后由看板把决定准确送回同一 Work Item、同一 Run、同一 Codex task。

本轮只提供领域模型、API 和 Codex App Server 路由，不新增页面，也不实现“通过验收、退回修改、接受当前结果并创建后续任务”。这些分别属于 M4 视图与 M3.3 验收动作。

触及并保护 `I-01`、`I-03`、`I-05`～`I-07`、`I-11`～`I-13`、`I-15`。没有改变任何产品不变量。

## 2. 真实交互

1. 执行中的 Codex 使用当前 Run、thread 和 turn 提交 Decision Request。
2. 看板原子保存请求，并将 Run 从 `running` 改为 `waiting`、Work Item 改为 `awaiting_decision`。
3. 原 turn 随后结束时不会被误当成完成执行，也不会生成 Review Submission。
4. 用户在看板选择选项或填写补充说明。
5. 看板先持久化用户决定，再通过 Codex App Server 对原 thread 执行 `thread/resume → turn/start`。
6. 新 turn 成功绑定后，同一个 Run 回到 `running`，Work Item 回到 `active`。
7. 新 turn 最终完成后，沿用 M3.1 进入唯一 Review Submission 和 `in_review`，不会进入 `done`。

## 3. Decision Request 数据

每条请求保存：

- 问题与最小背景摘要。
- 2～5 个结构化选项。
- 推荐选项及推荐理由。
- 风险与“不回答”的默认后果。
- 原 Work Item、Run、thread、turn。
- 用户选择、补充回答、回答人和回答时间。
- 回答所创建的新 turn。
- `not_requested / routing / routed / failed / uncertain` 路由状态。
- 版本、actor、来源 thread、时间和完整变更审计。

原始对话不复制进 SQLite。`sourceUri` 和 `answerUri` 精确引用对应的 Codex task/turn。

## 4. API

```http
POST /api/runs/:runId/decision-requests
GET  /api/runs/:runId/decision-requests
GET  /api/work-items/:workItemId/decision-requests
GET  /api/decision-requests/:id
GET  /api/decision-requests/:id/audit
POST /api/decision-requests/:id/answer
```

创建请求必须使用 Codex attribution，并提供当前 Run/Work Item version、当前来源 turn 和幂等键。回答必须使用用户 attribution，并提供 Decision Request、Run、Work Item 三个 expected version 和幂等键。

## 5. 幂等、并发与失败安全

- 相同请求幂等键只创建一条 Decision Request。
- 一个 Run 同时最多存在一个待回答请求。
- 来源 thread/turn 必须与当前 Run 完全一致，跨 task 请求直接拒绝。
- 回答先落库再触发外部 Codex 操作；相同回答幂等键不会创建第二个 turn。
- `thread/resume` 前失败标记为 `failed`，允许使用同一幂等键安全重试。
- thread 已恢复但 turn 结果未知时标记为 `uncertain`，禁止自动重试。
- Work Item、Run 或请求 version 过期时返回冲突，不静默覆盖。

## 6. 验证要求

- 全量 M0～M3.1 回归继续通过，现有任务看板页面无变化。
- Codex 来源错误、重复请求、过期 version 和无效选项均被拒绝或幂等处理。
- 请求产生后状态为 `waiting + awaiting_decision`，旧 turn 完成不会生成 Review。
- 用户回答只恢复原 thread，并把新 turn 重新绑定到同一 Run。
- 回答重放不会再次调用 Codex。
- 新 turn 完成后只进入 `in_review`，由用户决定是否完成。
- SQLite 审计能还原“Codex 提问 → 用户回答 → 系统路由”的完整链路。

## 7. 下一步

M3.3 实现人工验收动作：通过、退回修改、接受当前结果并创建后续任务。M4 再把 Decision Request 和 Review 作为“今日工作台/任务详情”的正式交互卡片展示。
