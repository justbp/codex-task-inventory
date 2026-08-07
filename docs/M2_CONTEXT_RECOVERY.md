# M2：上下文生成、暂停与恢复

状态：Implemented for review

基线：M1 `3ed17f3`

保护的不变量：`I-01`、`I-02`、`I-03`、`I-04`、`I-08`、`I-09`、`I-15`；继续回归 `I-05`、`I-07`、`I-11`、`I-12`、`I-13`。

## 1. 本里程碑解决的问题

M2 把执行所需的长期上下文从 Codex 对话中移到 Work Item。启动 Run 时，看板根据指定的 Work Item version 生成 Context Envelope，并把完整 Envelope 冻结在 Run 上。恢复工作不需要读取旧对话全文，也不会让后续任务修改静默改变旧 Run 的范围。

本里程碑仍不新增页面，不负责真实创建 Codex thread、Decision Request 路由、Review Submission 或今日工作台。

## 2. Work Item 上下文字段

`work_items` 新增：

- `goal`：目标结果。
- `next_action`：下一步唯一动作。
- `acceptance_criteria`：结构化验收标准。
- `scope_allowed`、`scope_excluded`：允许和排除范围。
- `stop_conditions`：停止条件。
- `constraints`：约束与风险边界。

这些字段使用原有 `expectedVersion` 更新，每次修改递增 Work Item version 并保留审计记录。

## 3. 结构化上下文实体

新增四类附属记录：

- `work_item_decisions`：已确认决定及理由。
- `work_item_recovery_points`：目标、当前结论、已完成、未解决、下一步和资源引用。
- `work_item_relations`：`parent`、`blocked_by`、`related`。
- `work_item_evidence_refs`：证据类型、名称、URI 和短摘要。

附属记录为追加式事实。创建时必须提供 Work Item `expectedVersion` 和 `idempotencyKey`，记录 actor、来源 Codex thread、时间与自身 version，并原子递增 Work Item version。

证据只保存 URI 和不超过 2,000 字符的短摘要，不保存完整日志、对话或文件内容。

## 4. Readiness 检查

实现 Run 必须具备：

- `goal`
- `nextAction`
- 至少一条 `acceptanceCriteria`
- `scope.allowed`

缺失任一字段时，`implementation` Run 返回 `409 work_item_not_ready`，同时给出缺失字段和 `suggestedMode=explore`。

`explore` Run 可以启动，但 Envelope 明确限制为只读探索，默认禁止修改代码、数据和外部系统。它的输出应是问题定义、关键发现、风险和建议下一步。

## 5. Context Envelope

生成接口：

```text
GET /api/work-items/:id/context-envelope?expectedVersion=7&mode=implementation
```

Envelope 包含：

- `contextVersion` 和 `generatedAt`。
- Work Item ID、version、目标、阶段、状态与下一步。
- 验收标准、范围、停止条件与约束。
- 已确认 Decision 摘要。
- 最新 Recovery Point。
- 任务关系。
- 证据引用。
- 每项摘要的来源 ID 与 version。
- 本 Run 的模式、目标、预期输出和汇报格式。

Envelope 不查询或复制旧 Codex 对话。空的可选字段显式使用“未提供”、空数组或 `null`。

## 6. Run 快照

创建 Run：

```text
POST /api/work-items/:id/runs
```

请求必须包含：

```json
{
  "idempotencyKey": "launch-task-123-attempt-2",
  "expectedVersion": 7,
  "mode": "implementation",
  "objective": "继续完成上下文模型"
}
```

服务在同一次同步操作中验证 Work Item version、执行 readiness 检查、生成 Envelope 并创建 Run。Run 保存：

- `run_mode`
- `expected_output`
- `context_envelope`
- `context_work_item_version`

Envelope 的 `generatedAt` 不参与幂等请求身份；相同业务请求重试仍返回第一次创建的 Run。快照创建后不可修改。任务目标随后变化只产生新的 Work Item version，不会改写旧 Run。

## 7. 暂停与恢复

创建恢复点：

```text
POST /api/work-items/:id/recovery-points
```

示例：

```json
{
  "idempotencyKey": "pause-task-123-v7",
  "expectedVersion": 7,
  "sourceRunId": "...",
  "currentConclusion": "核心路径已确定",
  "completed": ["完成数据模型"],
  "unresolved": ["尚未接入页面"],
  "nextAction": "接入任务详情 API",
  "resourceRefs": ["artifact://test/report"],
  "status": "parked"
}
```

直接把任务 PATCH 为 `parked` 或 `blocked` 会返回 `409 recovery_point_required`。用户通过 Recovery Point 原子保存恢复信息、下一步并改变状态。新 Run 的 Envelope 自动使用最新 Recovery Point。

Codex 可以自动保存 Recovery Point，但不能借此改变 Work Status；状态变化仍需要用户确认。

## 8. 权限边界

- Codex 可写：证据引用、自身 Run 的 Recovery Point 和不改变任务状态的下一步摘要。
- Codex 不可直接写：用户决定、任务关系、Work Status。
- Run 创建后的 mode、expected output 和 Context Envelope 不可修改。
- 标记 Done 的原有用户验收边界保持不变。

## 9. API

| Method | Path | 用途 |
| --- | --- | --- |
| GET | `/api/work-items/:id/context` | 读取 Decision、Recovery、关系和证据 |
| GET | `/api/work-items/:id/context-envelope` | 按指定 version 预览 Envelope |
| POST | `/api/work-items/:id/decisions` | 记录已确认决定 |
| POST | `/api/work-items/:id/recovery-points` | 保存恢复点，可由用户确认暂停/阻塞 |
| POST | `/api/work-items/:id/relations` | 增加任务关系 |
| POST | `/api/work-items/:id/evidence` | 增加证据引用 |
| POST | `/api/work-items/:id/runs` | readiness 检查后生成快照并创建 Run |

## 10. 迁移与回滚

M2 对 M1 表使用可重复的增量 `ADD COLUMN`，旧 Work Item 的新字段使用空值默认；新增上下文表不修改旧表数据。旧任务因此不会被误判为可直接实现，但仍可启动只读探索 Run。

回退到 M1 时，M1 会忽略新增列和表，原有看板继续使用兼容层。正式数据迁移前仍按 M0 方式执行 SQLite 一致性备份。

## 11. 验证映射

| 验收要求 | 测试 |
| --- | --- |
| 新对话仅靠 Envelope 描述任务 | `tests/work-context.test.mjs`、`tests/server.test.mjs` |
| 旧 Run 范围不随 Work Item 更新 | 同上 |
| Recovery Point 可用于新 Run 恢复 | 同上 |
| 不成熟任务不能启动实现 Run | 同上 |
| 不成熟任务可转换成只读探索 | 同上 |
| 证据只保存引用和短摘要 | `tests/work-context.test.mjs` |
| 上下文写入版本化、可归因、幂等 | `tests/work-context.test.mjs` |
| Codex 不能越权改变决定、关系和状态 | `tests/work-context.test.mjs`、M1 回归测试 |
| M0/M1 行为保持不变 | 全量测试 |

## 12. 下一里程碑边界

M3 可以增加 Decision Request、结构化进展和 Review Submission，并把用户回答准确发送回原 Run，但不得：

- 让 Codex 直接把 Work Item 标记为 Done。
- 把完整日志或对话复制到 Work Item。
- 修改既有 Run 的 Context Envelope。
- 绕过幂等键、expectedVersion 或用户确认边界。
