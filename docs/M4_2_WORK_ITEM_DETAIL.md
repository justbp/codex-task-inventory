# M4.2：统一任务详情与人工处理入口

## 1. 本轮目标

让用户在看板内读取一个 Work Item 的完整结构化事实，并直接处理 Decision Request 和 Review Submission。只有需要深入讨论或核查原始证据时才进入 Codex 对话。

## 2. 统一详情

新增只读接口：

```text
GET /api/work-items/:id/detail
```

一次返回：

- 最新 Work Item。
- 该任务的全部 Run。
- Decision、Recovery Point、关系和 Evidence Ref。
- Decision Request。
- Review Submission 及对应 Review Action。

接口不返回完整 Codex 对话、终端日志或原始证据正文。

今日工作台点击卡片直接打开详情；现有任务看板的线程抽屉增加“打开工作详情”，通过明确的 `workItemId` 进入同一个详情页面。

## 3. Decision 交互

待回答 Decision Request 展示：

- 问题和背景。
- 选项、Codex 推荐和理由。
- 风险与默认后果。
- 用户补充说明。

提交复用 M3.2 API，携带 Decision、Run、Work Item 三个 expected version 和一个稳定的 idempotency key。回答只发送到该 Request 绑定的原 Run。

## 4. Review 交互

最新 Review 展示完成摘要、验证结果、风险、建议下一步及原 Run 证据入口。用户可明确选择：

- 通过：当前 Work Item 进入 `done`。
- 退回修改：必须填写反馈，创建同一 Work Item 的新 Run 并继续主对话。
- 接受并创建后续：当前 Work Item 进入 `done`，另建独立 `inbox` Work Item。

提交复用 M3.3 API，携带 Review/Work Item expected version 和稳定幂等键。操作进行中禁用重复提交；失败后保留同一幂等键，重新读取最新事实。

## 5. 不变量验证

- `I-01/I-02`：详情由 Work Item 聚合，thread 只作为 Run 位置。
- `I-03/I-04`：退回修改仍继续原主对话，并由后端重建 Context Envelope。
- `I-05`：Work Status 与 Run Status 分区展示。
- `I-06/I-07`：Decision 和验收表单都要求用户明确提交。
- `I-11/I-12/I-13`：写操作保留归因、expected version 和 idempotency key。
- `I-15`：只展示结构化摘要和引用。

## 6. 后续边界

M4.3 实现可配置 WIP 上限、超限提示和可选阻止策略。M5 才引入看板管家 AI 建议，不允许 AI 直接提交本页的用户决定或验收动作。
