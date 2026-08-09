# M3.1：Run → Review 生命周期

## 1. 目标与边界

本里程碑解决真实测试发现的状态断层：Codex turn 已经结束，但领域 Run 仍长期停留在 `running`。

本次只打通“真实终态 → Run → Review Submission → Work Item `in_review`”，不实现 Decision Request、用户通过、退回修改或创建后续任务。这些仍属于后续 M3 子里程碑。

触及并保护 `I-01`、`I-03`、`I-05`～`I-07`、`I-10`～`I-13`、`I-15`。没有改变任何产品不变量。

## 2. 两条终态来源

### 实时回调

Codex App Server 发出：

1. `item/completed`：收集最终 `agentMessage`。
2. `turn/completed`：取得 `completed`、`interrupted` 或 `failed` 终态。

执行桥在关闭 App Server 客户端前完成领域同步。

### 重启恢复

如果服务在回调落库前退出，Codex Monitor 会从本地 rollout 中读取最近一组完成或中断的 turn ID（每个 thread 最多 50 个）。看板在监控刷新和读取任务列表时先执行 reconciliation，再应用旧看板的可见性过滤。内部终态集合不会出现在公共看板响应中。

因此，短暂进程故障不会让已经结束的 Run 永久停留在 `running`。

## 3. 幂等与并发语义

终态事件键为：

```text
{threadId}:{turnId}:{status}
```

- Run 只接受与自身绑定 thread/turn 完全匹配的事件。
- 第一次事件原子保存 Run 终态、终态时间和错误摘要。
- 同一个事件重放直接返回已有结果，不递增版本、不重复创建 Review Submission。
- Run 已结束后收到不同终态，返回冲突，不使用最后写入覆盖。
- 实时回调和 rollout reconciliation 共用同一处理逻辑。

## 4. 状态转换

| Codex turn | Run Status | Review Submission | Work Status |
| --- | --- | --- | --- |
| `completed` | `completed` | 创建一份 | `ready/active → in_review` |
| `interrupted` | `interrupted` | 不创建 | 保持原状态 |
| `failed` | `failed` | 不创建 | 保持原状态 |

如果用户已经把 Work Item 改为 `blocked`、`parked`、`canceled`、`done` 或其他状态，迟到的完成事件不会覆盖用户决定。Review Submission 仍作为该 Run 的执行结果保存。

Codex 完成只会进入 `in_review`，永远不会进入 `done`。最终完成权仍属于用户。

## 5. Review Submission

每个成功 Run 最多一份 Review Submission，保存：

- 完成摘要。
- 验证结果摘要。
- 风险摘要。
- 需要用户决定的摘要。
- 建议下一步。
- 来源 Work Item version。
- `codex://` thread/turn 原始证据引用。
- actor、来源 thread、时间和版本。

系统只解析并截取结构化短摘要，不复制完整对话、命令输出或测试日志。

查询 API：

```http
GET /api/work-items/:id/reviews
GET /api/runs/:id/review
```

## 6. 验证要求

- App Server 协议测试验证最终 agent message 和 turn 终态均被消费。
- API 测试验证 Run 终态、唯一 Review Submission 和 `in_review` 状态。
- 重放同一完成事件不产生重复记录。
- 中断事件不伪造验收提交。
- 模拟遗漏实时回调后，可以从 rollout 状态恢复。
- M0～M2 全部回归继续通过，现有看板页面不改变。

真实数据恢复验证使用 M2 测试数据库的副本：三个已完成但仍为 `running` 的 Run（其中两个属于同一 thread）均恢复为 `completed`，生成三份唯一 Review Submission，Work Item 进入 `in_review`，SQLite `integrity_check` 返回 `ok`。

## 7. 后续 M3 边界

下一子里程碑继续实现：

- Decision Request 与回答回原 Run。
- 用户“通过、退回修改、接受当前结果并创建后续任务”。
- 任务详情中的 Review 交互。
