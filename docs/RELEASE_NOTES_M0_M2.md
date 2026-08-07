# Codex Workbench M0～M2 功能清单

状态：Initial backend foundation

发布日期：2026-08-07

提交范围：

- M0 `57f23f1`：现有监控行为基线。
- M1 `3ed17f3`：Work Item 与 Run 基础模型。
- M2 `e53eb04`：上下文生成、暂停与恢复。
- 交互规格 `586067a`：目标产品交互与实现状态。

## 1. 用户可见的现有任务看板

- 从本机 Codex 状态读取任务、名称和真实运行状态。
- 展示执行中、等待我、待 Review、已完成等运行监控状态。
- 支持手工任务创建、项目、工作目录、标签、优先级、排序、置顶和备注。
- 待办任务可以启动真实 Codex 对话；绑定成功后不保留重复手工卡片。
- 支持完成页和收藏页。
- 已完成人工确认后，如果 Codex 再次执行，会重新进入待 Review。
- 支持中断确认；发生更新的中断时重新提醒。
- 任务从执行中进入待 Review 时支持 macOS 通知。
- 保留原有四阶段看板和运行监控交互，没有因 M1/M2 改变页面。

## 2. Work Item 与 Run 领域模型

- Work Item 是长期工作任务和事实来源，不依赖 Codex thread 是否存在。
- Work Item 可以没有 Run，也可以关联多个 Run。
- Codex thread 和 turn 只作为一次 Run 的执行位置。
- Work Status 与 Run Status 使用独立字段和枚举。
- Work Item 与 Run 分别拥有独立 ID、version、创建和更新时间。
- 现有手工任务、线程元数据和监控线程可以增量映射到新模型。
- 已绑定手工任务的 thread 不会再生成第二个 Codex Work Item。
- 重复启动迁移不会重复创建 Work Item、Run 或审计事件。

## 3. 并发、幂等与审计

- Work Item 和 Run 更新必须提供 `expectedVersion`。
- 旧 version 写入返回 `409 version_conflict`，不会静默覆盖新内容。
- Work Item、Run 和上下文实体创建支持 idempotency key。
- 相同 key 和相同请求返回第一次结果。
- 相同 key 和不同请求返回 `409 idempotency_conflict`。
- 创建实体和写入幂等记录处于同一 SQLite 事务。
- 写入记录 actor type、actor ID、来源 Codex thread、时间和版本变化。
- Codex 不能自行把 Work Item 标记为 `done`。

## 4. 结构化任务上下文

Work Item 支持保存：

- 目标结果 `goal`。
- 下一步唯一动作 `nextAction`。
- 验收标准 `acceptanceCriteria`。
- 允许范围与排除范围 `scope`。
- 停止条件 `stopConditions`。
- 约束与风险边界 `constraints`。

新增结构化上下文实体：

- Decision：用户确认的决定和理由。
- Recovery Point：当前目标、结论、已完成、未解决、下一步和资源引用。
- Relation：`parent`、`blocked_by`、`related`。
- Evidence Ref：证据类型、名称、URI 和短摘要。

SQLite 不保存完整 Codex 对话、推理过程、全量终端输出、完整测试日志、图片、附件或文件正文。

## 5. Readiness 与探索模式

实现 Run 需要具备：

- `goal`
- `nextAction`
- 至少一条 `acceptanceCriteria`
- `scope.allowed`

缺少关键字段时：

- 禁止启动 `implementation` Run。
- 返回具体缺失字段和 `suggestedMode=explore`。
- 允许创建只读 `explore` Run。
- 探索 Envelope 默认禁止修改代码、数据和外部系统。

## 6. Context Envelope 与 Run 快照

- 可以按指定 Work Item version 生成版本化 Context Envelope。
- Envelope 包含任务目标、阶段、状态、下一步、验收标准、范围、约束、Decision、最新 Recovery Point、关系、证据引用和 Run 输出要求。
- 每项摘要带来源 ID 和 version。
- Envelope 不查询或复制旧 Codex 对话。
- 创建 Run 时保存完整 Envelope 和对应 Work Item version。
- Work Item 后续修改不会改变旧 Run 的目标或范围。
- Run 创建后的 mode、expected output 和 Context Envelope 不可修改。
- Envelope 生成时间不影响 Run 幂等身份。

## 7. 暂停与恢复

- 任务暂停、阻塞或切换主线前必须保存 Recovery Point。
- 直接把 Work Item PATCH 为 `parked` 或 `blocked` 返回 `409 recovery_point_required`。
- 用户可以原子保存 Recovery Point、更新下一步并确认状态变化。
- 新 Run 的 Envelope 自动带上最新 Recovery Point。
- Codex 可以保存恢复摘要和证据引用，但不能借此改变 Work Status。
- Codex 不能未经用户确认记录用户决定或修改任务关系。

## 8. 新增后端 API

### Work Item 与 Run

- `GET/POST /api/work-items`
- `GET/PATCH /api/work-items/:id`
- `GET/POST /api/work-items/:id/runs`
- `GET /api/runs/:id`
- `PATCH /api/runs/:id`
- `GET /api/work-items/:id/audit`
- `GET /api/runs/:id/audit`

### 上下文

- `GET /api/work-items/:id/context`
- `GET /api/work-items/:id/context-envelope`
- `POST /api/work-items/:id/decisions`
- `POST /api/work-items/:id/recovery-points`
- `POST /api/work-items/:id/relations`
- `POST /api/work-items/:id/evidence`

## 9. 数据升级与回滚

- M1 新增 Work Item、Run、审计和幂等表，不删除旧表。
- M2 以可重复的增量列和新上下文表升级 M1 数据库。
- 旧看板继续由兼容层读取原有 `manual_tasks` 和 `thread_metadata`。
- 回退旧应用版本时，旧版本会忽略新增表和列。
- 正式迁移前继续使用 SQLite 一致性备份。

## 10. 验证结果

- TypeScript 类型检查通过。
- 生产构建通过。
- 自动化测试 34/34 通过。
- 真实看板数据库副本升级成功。
- 数据库重复升级后任务、Run 和审计数量不变。
- SQLite `integrity_check` 返回 `ok`。
- 独立临时 Codex 不读取当前聊天，仅靠仓库文档成功恢复上下文管理设计。
- 现有任务看板的 M0 行为全部通过回归。

## 11. 当前尚未提供

以下内容属于后续里程碑，不能视为本次已经上线：

- Work Item 上下文的网页表单和任务详情页面。
- “开始探索”“开始执行”“暂停”和“恢复”按钮。
- 自动创建真实 Codex thread 并发送 Context Envelope。
- Codex 自动结构化回写进展、决定请求和验收报告。
- Decision Request 卡片及回答到原 Run 的路由。
- Review Submission 与人工验收闭环。
- 今日工作台。
- 看板管家 AI、自动安排、提醒和复盘。

## 12. 产品不变量

本次版本保护 `I-01` 至 `I-15`，重点包括：

- Work Item 是任务事实来源，任务与对话分离。
- 每次执行从看板重建上下文。
- Work Status 与 Run Status 分离。
- 用户拥有价值判断和最终验收权。
- 信息不足时先探索。
- 暂停必须可恢复。
- 所有写入可归因、版本化，外部副作用幂等。
- 看板保存摘要和证据引用，不复制全部原始内容。
