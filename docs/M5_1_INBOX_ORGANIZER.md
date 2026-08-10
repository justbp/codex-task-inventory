# M5.1：整理收集箱

## 本轮目标

把收集箱里的模糊任务交给独立的看板管家整理，但所有变更仍由用户确认。看板管家只生成结构化建议，不执行任务、不启动 Run、不决定今日主线，也不能把任务标记为完成。

## 用户交互

1. 用户在“今日工作台”点击“整理收集箱”。
2. 看板读取当前 `inbox` Work Item 的最小摘要，启动一个独立、只读且禁止审批升级的 Codex 调用。
3. 页面展示每条建议的理由、影响和字段修改前后差异；所有建议默认不勾选。
4. 用户逐项勾选并点击“应用所选建议”。
5. 服务端检查 Work Item 版本，并在一个事务中应用整批建议；任何一项冲突都会让整批回滚。
6. 页面刷新 Work Item，审计记录保留请求人、生成建议的 Codex task，以及确认应用的用户。

“疑似重复”当前仅作提示，不会自动合并或删除任务。

## 最小上下文

管家调用只接收可见的收集箱任务及以下字段：

- `id`、`version`
- `title`
- 截断后的 `description`（作为摘要）、`goal`、`nextAction`
- `project`、`tags`
- `createdAt`、`updatedAt`

不会加载 cwd、scope、验收标准、Run、Codex 对话、日志或其他任务全文。调用使用独立 Codex task，并从普通 Run 看板隐藏，避免把任务执行上下文堆进管家对话。

## API 与持久化

- `POST /api/board-manager/inbox-organize`：创建一次整理调用，支持幂等键。
- `GET /api/board-manager/calls/latest`：查询最近一次整理。
- `GET /api/board-manager/calls/:id`：查询调用和建议。
- `POST /api/board-manager/calls/:id/apply`：原子应用用户选择的建议，支持幂等键。
- `GET /api/board-manager/calls/:id/audit`：查询请求、生成、应用审计链。

SQLite 新增 `board_manager_calls`、`board_manager_suggestions`、`board_manager_idempotency` 和 `board_manager_audit_events` 四张表。

## 不变量验证

- `I-01`：建议最终通过 Work Item Repository 写入；Codex task 不是事实源。
- `I-03`：管家调用为独立、只读 task，不执行任务且不创建 Run。
- `I-06`、`I-10`、`I-14`：建议默认不选，展示差异后由用户逐项确认；不允许建议 `done`、主线或优先级。
- `I-11`、`I-12`：Codex 生成和用户应用分别记录 actor、thread 与版本；写入使用乐观锁。
- `I-13`：生成与应用都有请求哈希和幂等键，整批应用使用事务。
- `I-15`：输入为收集箱最小摘要，不读取 Run、对话或日志。

## 验收重点

- 首次打开面板会生成或复用一次整理调用，运行中可自动刷新。
- 更新建议默认未勾选；只有勾选后才能应用。
- 应用后对应 Work Item 版本递增、字段按预览变化。
- 疑似重复建议只能查看，不能自动合并。
- 同一个幂等键重复生成或应用不会产生重复副作用。
- 任一任务版本冲突时，所选建议全部不落库。

M5 尚未完成的动作是“安排今天、分析阻塞、整理待验收”；界面保留入口但当前禁用。
