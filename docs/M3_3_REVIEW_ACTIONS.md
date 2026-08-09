# M3.3：人工验收动作闭环

## 1. 目标与边界

本子里程碑完成 M3 的最后一段领域闭环：用户对最新 Review Submission 作出明确验收，并由看板执行“通过、退回修改、接受当前结果并创建后续任务”。

本轮提供领域模型、API、Codex Run 续跑和审计，不新增页面。正式验收卡片和任务详情交互属于 M4。

触及并保护 `I-01`～`I-07`、`I-11`～`I-13`、`I-15`，没有修改任何产品不变量。

## 2. 三种动作

### 通过 `approve`

- 只有用户 attribution 可以执行。
- 目标必须是当前最新、尚未处理的 Review。
- Review 对应 Run 必须已经 `completed`，Work Item 必须处于 `in_review`。
- Run 保持历史终态；Work Item 由用户明确改为 `done`。
- 不启动 Codex，不产生新 Run。

### 退回修改 `request_changes`

- 必须填写结构化验收意见。
- 原 Review 和原 Run 保持不变，不能把已完成 Run 改回运行中。
- 看板把验收意见写入 Work Item 的 `nextAction`，并保存一条引用原 Review 的 `review_feedback` Evidence Ref。
- 基于最新 Work Item version 重新生成 Context Envelope，创建新的 Run。
- 新 Run 默认继续原 Work Item 的主 Codex task，通过 `thread/resume → turn/start` 创建新 turn。
- 新 Run 成功启动后，Work Item 进入 `active`；完成后再次进入 `in_review` 并生成新的 Review。

### 接受当前结果并创建后续任务 `accept_with_follow_up`

- 用户明确接受当前结果，因此原 Work Item 进入 `done`。
- 创建新的独立 `inbox` Work Item，不复用原任务状态或 Run。
- 新任务建立 `parent → 原 Work Item` 关系，保留来源链路。
- 后续任务默认不自动启动 Codex，由用户后续整理和批准。

## 3. 数据与 API

每个 Review 最多有一条 `work_item_review_actions`：

- 动作类型和 `applying / applied / failed / uncertain` 状态。
- 结构化验收意见。
- 原 Work Item、原 Review、原 Run。
- 修订 Run 或后续 Work Item。
- 原 Review 的证据 URI。
- actor、来源 task、时间、version、错误摘要和完整变更审计。

API：

```http
POST /api/reviews/:reviewId/actions
GET  /api/reviews/:reviewId/action
GET  /api/review-actions/:actionId/audit
```

写入必须携带 `idempotencyKey`、`expectedReviewVersion` 和 `expectedWorkItemVersion`。

## 4. 幂等、并发与恢复

- 同一个 Review 只能处理一次。
- 相同幂等键重放返回同一验收动作，不会重复完成任务、创建后续任务或启动修订 Run。
- 版本过期、目标不是最新 Review、Work Item 不在 `in_review` 或 Run 未完成时均返回冲突。
- “通过”和“接受并创建后续”在单个 SQLite 事务中完成。
- “退回修改”先原子保存反馈和待执行动作，再调用 Codex 外部副作用。
- 服务在保存动作后重启时，`applying` 动作可用相同幂等键继续；Run 创建本身也使用派生幂等键。
- Codex 启动失败或结果不确定时，反馈不会丢失；动作分别记录 `failed` 或 `uncertain`，不会自动重复启动。

## 5. 不变量验证

- `I-01/I-02`：验收结果、修订任务和后续任务全部落在看板事实模型中。
- `I-03/I-04`：修订新建 Run，优先恢复原主 task，并使用含最新反馈的 Context Envelope。
- `I-05`：旧 Run 保持 `completed`，新 Run 独立进入 `running`；Work Item 使用独立状态。
- `I-06/I-07`：非用户调用返回 403，只有 `approve` 或 `accept_with_follow_up` 的用户动作进入 `done`。
- `I-11/I-12`：动作、任务、关系、证据和 Run 都有 attribution、审计及 expected version。
- `I-13`：验收、后续任务、关系、证据和修订 Run 均受幂等键保护。
- `I-15`：仅保存反馈摘要和 Review URI，不复制对话或测试日志。

## 6. 后续

M3 至此形成完整后台闭环。下一里程碑 M4 新增“今日工作台”和任务详情，把等待决定、待验收及三种验收动作变成用户日常使用的正式界面。
