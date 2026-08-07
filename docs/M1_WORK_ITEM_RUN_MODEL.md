# M1：Work Item 与 Run 基础模型

状态：Implemented for review

基线：M0 `57f23f1`
保护的不变量：`I-01`、`I-02`、`I-05`、`I-07`、`I-11`、`I-12`、`I-13`

## 1. 本里程碑解决的问题

M0 中的看板仍以手工任务或 Codex Thread 作为卡片来源。M1 新增独立领域层，使工作任务能够脱离对话存在，并允许一个工作任务关联多次 Codex 执行。

本里程碑不改变现有页面，不生成 Context Envelope，也不负责暂停恢复、决策卡或今日工作台。

## 2. 数据模型

### `work_items`

工作任务的长期实体，包含：

- `id`：独立 UUID。
- `title`、`description`。
- `status`：Work Status。
- `stage`：工作阶段。
- `project`、`cwd`、`tags`、`priority`、排序和显示属性。
- `source_kind`、`source_id`：仅用于迁移已有手工任务或 Codex Thread，由系统维护。
- `version`：每次修改递增，用于乐观并发控制。
- 创建与更新时间。

### `work_item_runs`

一次执行记录，包含：

- 独立 Run ID 和所属 Work Item ID。
- Run Status。
- 本次执行目标。
- Codex thread ID 和 turn ID。
- 独立 version、创建与更新时间。

Work Item 与 Run 是一对多关系。Work Item 不要求存在 Run；Codex Thread 只能作为 Run 的执行位置，不能替代 Work Item。

### `work_item_audit_events`

记录每次 Work Item/Run 写入的：

- entity、action。
- actor type、actor ID、来源 Codex thread ID。
- 修改前后 version。
- 修改前后结构化快照。
- 创建时间。

同一毫秒内的事件按 SQLite 写入顺序返回，避免 UUID 排序造成审计顺序不稳定。

### `idempotency_records`

按 operation 与 idempotency key 保存请求哈希和响应。记录与实际创建处于同一个 SQLite 事务内：

- 相同 key、相同请求：返回第一次响应。
- 相同 key、不同请求：返回 `409 idempotency_conflict`。
- 事务失败：实体与幂等记录一起回滚。

## 3. 状态独立性

Work Status 与 Run Status 使用不同字段和枚举：

- Work Status：`inbox`、`ready`、`active`、`awaiting_decision`、`in_review`、`blocked`、`parked`、`done`、`canceled`。
- Run Status：`queued`、`running`、`waiting`、`completed`、`interrupted`、`failed`、`canceled`。

修改 Run Status 不会隐式修改 Work Status。后续 M3 才会定义经过审计的流程联动。

Codex actor 即使带有合法 thread ID，也不能把 Work Item 修改为 `done`。

## 4. HTTP API

### Work Item

| Method | Path | 用途 |
| --- | --- | --- |
| GET | `/api/work-items` | 列出 Work Item |
| POST | `/api/work-items` | 创建独立 Work Item |
| GET | `/api/work-items/:id` | 读取最新版 |
| PATCH | `/api/work-items/:id` | 带 expectedVersion 更新 |
| GET | `/api/work-items/:id/audit` | 读取 Work Item 审计事件 |

创建示例：

```json
{
  "idempotencyKey": "capture-20260807-001",
  "title": "建立任务上下文模型",
  "description": "先建立独立任务实体",
  "status": "ready",
  "stage": "execute"
}
```

更新示例：

```json
{
  "expectedVersion": 1,
  "title": "建立 Work Item 与 Run 模型"
}
```

客户端使用旧 version 更新时返回：

```json
{
  "error": "工作任务已被其他操作修改，请重新读取",
  "code": "version_conflict"
}
```

### Run

| Method | Path | 用途 |
| --- | --- | --- |
| GET | `/api/work-items/:id/runs` | 列出任务的全部 Run |
| POST | `/api/work-items/:id/runs` | 幂等创建 Run |
| GET | `/api/runs/:id` | 读取 Run |
| PATCH | `/api/runs/:id` | 带 expectedVersion 更新 Run |
| GET | `/api/runs/:id/audit` | 读取 Run 审计事件 |

创建 Run 示例：

```json
{
  "idempotencyKey": "launch-task-123-attempt-1",
  "objective": "验证任务与对话分离",
  "status": "queued",
  "codexThreadId": "019...",
  "codexTurnId": "turn-..."
}
```

## 5. 写入归因

HTTP API 从以下请求头取得归因：

- `x-actor-type`：`user`、`codex` 或 `system`，默认 `user`。
- `x-actor-id`：操作者标识，默认 `local-user`。
- `x-codex-thread-id`：来源 Codex 对话。

当 `x-actor-type=codex` 时必须提供 `x-codex-thread-id`，否则拒绝写入。

迁移事件使用：

```text
actor_type = system
actor_id = legacy-migration
action = legacy_import
```

## 6. 旧数据映射

启动服务时使用单个可回滚事务进行增量映射，不修改或删除旧表：

1. 未绑定的 `manual_tasks`：创建一个 Work Item，不创建 Run。
2. 已绑定 Codex Thread 的 `manual_tasks`：创建一个 Work Item 和一个 Run。
3. 没有被手工任务占用的 `thread_metadata`：创建一个 Work Item 和一个 Run。
4. Codex monitor 已发现但尚无本地元数据的 thread：创建一个 Work Item 和一个 Run。
5. 已由手工任务关联的 thread 不再创建第二个 Codex Work Item。
6. 重复启动迁移不会重复创建 Work Item、Run 或审计事件。

旧表继续服务当前任务看板，作为 M0 兼容层。M1 新增 API 写入的新 Work Item 只存在于新领域层；现有页面切换到新模型属于后续里程碑。

在完成页面适配和真实使用验证前不得删除 `manual_tasks` 或 `thread_metadata`。

## 7. 回滚

M1 只新增四张表和索引，不修改旧表内容。回滚应用版本时，旧看板仍可读取原有 `manual_tasks` 和 `thread_metadata`。

正式部署前仍按 M0 流程备份数据库。若需要彻底撤销 M1 数据：

1. 停止服务并保留数据库诊断副本。
2. 回退应用版本。
3. 旧版本会忽略新增表，可直接运行。
4. 只有确认不再需要 M1 数据后，才能单独删除新增表；默认不删除。

## 8. 验证映射

| 验收要求 | 测试 |
| --- | --- |
| Work Item 可以没有 Codex Thread | `tests/work-items.test.mjs` |
| 一个 Work Item 可以有多个 Run | `tests/work-items.test.mjs` |
| 旧 version 写入被拒绝 | `tests/work-items.test.mjs`、`tests/server.test.mjs` |
| Run 创建具备原子幂等性 | `tests/work-items.test.mjs`、`tests/server.test.mjs` |
| 写入可追溯到 actor/thread | `tests/work-items.test.mjs`、`tests/server.test.mjs` |
| Codex 不能自行标记 Done | `tests/work-items.test.mjs` |
| 旧数据映射不产生重复任务 | `tests/work-items.test.mjs` |
| M0 看板行为保持不变 | 全部 M0 回归测试 |

## 9. 下一里程碑边界

M2 可以在 Work Item 上增加目标、验收标准、范围、决定、Recovery Point 和 Context Snapshot，但不得：

- 把完整 Codex 对话复制到 Work Item。
- 取消 expectedVersion 或审计记录。
- 把 Work Status 与 Run Status 合并。
- 让新 Context Envelope 静默修改旧 Run 的执行范围。
