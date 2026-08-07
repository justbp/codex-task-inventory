# M0：现有看板行为基线

状态：Implemented for review  
基线提交：`b0842f7`  
保护的不变量：`I-05`、`I-07`、`I-15`

## 1. 目的与边界

M0 在引入 Work Item/Run 新模型前，记录并测试当前看板已经成立的行为。后续里程碑可以替换底层实现，但必须继续满足这里的外部契约。

M0 不新增页面、不改变卡片交互、不引入 Work Item/Run，也不改变现有数据。

## 2. 当前事实来源

- Codex `state_5.sqlite`：只读获取线程标识、名称、目录、创建/更新时间、归档和置顶状态。
- Codex rollout JSONL：只读推导 `runtimeStatus`、活跃 turn、完成、中断、进展、文件变化和错误。
- 本地 `data/monitor.db`：保存看板自己的排布、项目覆盖、标签、优先级、备注、人工完成确认和手工任务。
- Codex App Server：读取用户可见线程名称、额度，并在启动手工任务时创建真实线程和 turn。

看板不把 rollout 全文复制到本地数据库，只保存推导后的摘要和时间戳。

## 3. 当前数据库契约

### `thread_metadata`

以 Codex `thread_id` 为主键，保存：

- 手工 lane、项目覆盖、标签、优先级和排序。
- pinned、hidden 和 note。
- completed_at。
- last_seen_completion、last_seen_interruption 和 review_tracking_started_at。

### `manual_tasks`

以本地 UUID 为主键，保存：

- title、note、lane、project 和 cwd。
- tags、priority、sort_order 和 pinned。
- codex_thread_id、completed_at、created_at 和 updated_at。

当 `codex_thread_id` 非空时，原手工任务不再出现在列表中；真实 Codex 线程接管卡片展示。

### 当前增量升级

服务启动时会为旧数据库补充：

- `manual_tasks.cwd`
- `manual_tasks.pinned`
- `thread_metadata.pinned`
- `thread_metadata.review_tracking_started_at`
- `thread_metadata.last_seen_interruption`

增量升级必须保留已有行和字段值。`tests/monitor-baseline.test.mjs` 使用旧表结构验证这一行为。

## 4. Lane 计算优先级

Codex 线程的显示 lane 按以下顺序计算，前面的规则优先：

| 条件 | 有效 lane |
| --- | --- |
| runtimeStatus 是 `active` 或 `waiting` | `in_progress` |
| Codex 线程已归档 | `completed` |
| 出现晚于确认基线的新完成事件 | `review` |
| 出现晚于确认基线的新中断事件 | `review` |
| 人工 lane 是 `completed` | `completed` |
| 其他情况 | 使用人工 lane |

因此，即使用户提前把正在运行的线程拖到已完成，只要 Codex 仍在 active/waiting，卡片仍显示在进行中。这是 `I-05` 的当前保护方式。

## 5. Review 与人工完成确认

1. Codex 首次出现新完成或新中断事件时，卡片进入 `review`。
2. 用户通过 Review 时，看板记录对应的 `last_seen_completion` 或 `last_seen_interruption`。
3. 已确认的同一事件不会重复进入 Review。
4. 同一线程之后出现更新的完成或中断事件时，再次进入 Review。
5. 只有用户操作可以确认 Review；Codex 运行结束本身不等于用户确认完成。

这组行为保护 `I-07`。

## 6. 手工任务启动流程

1. 用户在 `inbox` 或 `upcoming` 创建手工任务。
2. 只有 `upcoming` 允许启动。
3. 启动前 cwd 必须是存在的绝对目录。
4. 看板把 title 与 note 组合成启动 prompt。
5. Codex App Server 创建新 thread 和 turn。
6. 看板把手工任务元数据迁移到该 thread 的 `thread_metadata`。
7. 手工任务写入 `codex_thread_id`，不再作为独立卡片返回。
8. 真实 Codex 线程根据运行态出现在 `in_progress`。

## 7. HTTP API 基线

| Method | Path | 当前用途 |
| --- | --- | --- |
| GET | `/api/health` | 本地服务健康状态 |
| GET | `/api/quota` | Codex 额度；`refresh=1` 强制刷新 |
| POST | `/api/notifications/test` | 发送系统通知测试 |
| GET | `/api/threads` | 返回手工任务和可见 Codex 线程 |
| POST | `/api/items` | 创建手工任务 |
| POST | `/api/items/batch` | 批量修改手工任务 |
| POST | `/api/items/:id/start` | 启动手工任务并绑定真实 Codex 线程 |
| PATCH | `/api/items/:id` | 修改手工任务 |
| DELETE | `/api/items/:id` | 删除手工任务 |
| GET | `/api/events` | SSE 推送任务变化 |
| PATCH | `/api/threads/:id` | 修改 Codex 线程的看板元数据 |

`GET /api/threads` 的每个条目至少保留当前公共字段。Codex 条目额外包含 `hidden`，手工条目额外包含 `codexThreadId`；`lastInterruptedAt` 目前是可选字段。M1 以后可以通过适配层从新模型生成这个响应，但 M0 保护期内不直接让新页面依赖数据库表结构。

## 8. 迁移与回滚步骤

M1 修改 `monitor.db` 前必须执行：

1. 停止本地看板服务，禁止在运行中的 WAL 数据库上直接复制主文件。
2. 执行 `PRAGMA wal_checkpoint(TRUNCATE)` 和 `PRAGMA integrity_check`。
3. 将 `monitor.db` 复制为带时间戳的只读备份，并记录校验和。
4. 在备份副本上先运行迁移与基线测试。
5. 正式迁移使用单个事务；失败必须回滚事务并保持旧表可读。
6. 迁移后再次执行完整测试和 `PRAGMA integrity_check`。

回滚时：

1. 停止服务。
2. 保留失败数据库用于诊断。
3. 用已校验的迁移前备份恢复 `monitor.db`。
4. 删除与失败数据库配套的 `-wal`、`-shm` 文件后再启动旧版本服务。
5. 验证任务数量、人工备注、完成确认和手工任务绑定关系。

不得在服务运行时替换数据库文件。

## 9. 基线验证映射

| 行为 | 自动化测试 |
| --- | --- |
| rollout 推导 active、完成和中断 | `tests/codex-monitor.test.mjs` |
| active/waiting 优先显示进行中 | `tests/monitor-baseline.test.mjs`、`tests/server.test.mjs` |
| 首次与后续完成都进入 Review | `tests/server.test.mjs` |
| 中断确认后仅新中断再次 Review | `tests/server.test.mjs` |
| 人工任务启动并由真实线程接管 | `tests/server.test.mjs` |
| 旧数据库增量升级不丢任务 | `tests/monitor-baseline.test.mjs` |
| 页面保留等待我、待 Review 和人工通过 | `tests/rendered-html.test.mjs` |
| `/api/threads` 返回公共字段 | `tests/server.test.mjs` |

## 10. M1 适配要求

M1 可以新增 Work Item/Run 表和 API，但必须：

- 保持本文件第 4 至第 7 节的可见行为，或提供兼容适配层。
- 不把 Work Status 与 Run Status 合并。
- 不允许 Codex 完成事件直接确认工作完成。
- 只保存必要摘要和证据引用，不复制完整 rollout 或对话。
- 在删除旧表或旧字段前，先证明数据已迁移且回滚路径可用。
