# M4.1：今日工作台基础视图

## 1. 本轮目标

新增一个以 Work Item 和人的注意力为中心的“今日工作台”，同时保持现有任务看板继续以 Codex Run 实时状态为中心。

本轮只实现视图基础和用户手工主线，不实现任务详情、Decision/Review 正式交互或 WIP 限制。

## 2. 数据契约

Work Item 新增：

```json
{ "todayFocus": false }
```

- `todayFocus` 只表示用户当前是否把该任务作为今日主线，不改变 Work Status。
- 修改复用 `PATCH /api/work-items/:id`，必须携带 `expectedVersion`。
- 修改进入既有 Work Item 审计，Codex actor 不能改变该字段。
- 旧数据迁移后默认为 `false`，不影响现有任务状态。

## 3. 五个注意力区域

- 今日主线：用户设置 `todayFocus=true`，且任务不在等待决定、待验收、停车场或终态。
- 后台执行：Work Status 为 `active` 且未设置为今日主线。
- 等待决定：Work Status 为 `awaiting_decision`。
- 待验收：Work Status 为 `in_review`。
- 停车场：Work Status 为 `parked`。

同一任务在今日工作台按 Work Status/注意力归类；现有任务看板仍按 Run Status 展示，不共享列状态。

## 4. 用户交互

1. 打开 `/today`。
2. 从 `ready`、`active` 或 `blocked` 候选任务中选择一个 Work Item，点击“设为今日主线”；未整理的 `inbox` 不直接进入今日计划。
3. 页面带当前 Work Item version 写入并重新读取。
4. 主线卡片可点击“移出主线”。
5. 发生并发版本冲突时页面显示错误并重新读取，不静默覆盖。

M4.1 暂不限制主线数量。主线 WIP 的默认上限、提示和阻止模式属于 M4.3 的可配置策略。

## 5. 不变量验证

- `I-01`：今日工作台只读取和更新 Work Item，不以 Codex thread 为任务事实。
- `I-05`：今日工作台按 Work Status/注意力分组；任务看板继续按 Run Status 分组。
- `I-06`、`I-14`：只有用户选择主线，系统不替用户排序或取舍。
- `I-07`：`todayFocus` 不会把任务设为 `done`。
- `I-11`、`I-12`：主线写入记录 actor、版本和审计；旧 version 返回冲突。

## 6. 后续边界

- M4.2：统一任务详情，接入 Decision Request 和 Review Submission 的页面交互。
- M4.3：可配置 WIP 策略与超限提醒/阻止。
- M5：看板管家只能生成可审核建议，不能自动选择今日主线。
