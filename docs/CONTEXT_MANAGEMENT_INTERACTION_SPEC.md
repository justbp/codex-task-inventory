# 上下文管理交互规格

状态：Target interaction v1

日期：2026-08-07

用途：固定用户、看板与 Codex 围绕任务上下文的真实交互，防止后续实现因为 Codex 对话更换或上下文压缩而偏离产品目标。

本文描述目标产品形态，不表示所有界面和自动集成都已经实现。实现状态见第 10 节。

保护的不变量：`I-01`、`I-02`、`I-03`、`I-04`、`I-06`、`I-08`、`I-09`、`I-10`、`I-15`。

## 1. 核心交互原则

- 对话保存临时讨论。
- Work Item 保存长期任务事实。
- Decision 保存用户已经确认的选择。
- Recovery Point 保存任务恢复位置。
- Evidence 保存原始资料入口和短摘要，不保存资料正文。
- Run 保存当次执行实际收到的 Context Envelope。
- 看板根据明确的任务 ID、关系和版本组装上下文，不让 Codex 在全部历史中自由猜测。
- Codex 可以判断批准范围内当前需要查看什么，但不能自行扩大任务边界。
- 用户决定业务目标、范围扩大、风险取舍、生产操作和最终验收。

## 2. 示例任务

用户输入：

> FBA 发货草稿有时创建失败，查一下。

看板创建 Work Item：

```yaml
id: TASK-FBA-001
title: 排查 FBA 发货草稿创建失败
status: inbox
stage: explore
goal: 未提供
acceptance_criteria: []
scope: 未提供
next_action: 未提供
version: 1
```

此时任务已经存在，但尚未具备长时间实现条件，也不依赖任何 Codex 对话。

## 3. 第一次启动：信息不足时只读探索

用户点击“交给 Codex”。

看板执行 readiness 检查并显示：

```text
当前任务缺少：
- 明确目标
- 验收标准
- 允许范围
- 下一步动作

不能直接开始实现。
建议：启动只读探索。
```

用户选择“开始只读探索”。看板生成并发送：

```yaml
context_version: 1
work_item:
  id: TASK-FBA-001
  version: 1
  title: 排查 FBA 发货草稿创建失败
  goal: 未提供
  stage: explore
  next_action: 未提供
scope:
  allowed: 只读探索，定位问题并补充任务定义
  excluded: 不修改代码，不修改数据库，不操作生产环境
run:
  mode: explore
  objective: 找出创建失败的可能原因
  expected_output:
    - 问题定义
    - 关键发现
    - 风险
    - 建议下一步
```

Codex 收到的是本任务的结构化简报，不是全部任务、全部历史对话或所有日志。

## 4. 探索结束：只回写长期有价值的信息

Codex 调查后提交：

```yaml
current_conclusion: 草稿中的货件 SKU 与领星实时明细不一致
completed:
  - 定位失败接口
  - 核对草稿数据
  - 核对领星实时数据
unresolved:
  - 应修复草稿数据，还是修改校验逻辑
next_action: 等待用户选择处理方案
evidence_refs:
  - log://fba/20260807/123
  - artifact://lingxing/shipment-123.json
```

看板不保存：

- 完整 Codex 对话。
- 全量终端输出和测试日志。
- SQL 查询结果全文。
- 图片、附件和文件正文。
- Codex 推理过程。

原始内容继续留在原 Run、文件系统或外部证据系统中；SQLite 只保存引用和短摘要。

## 5. 用户决定：把确认结果升级为任务事实

看板展示 Decision Request：

```text
需要你决定：

A. 修复当前异常草稿数据
B. 修改校验逻辑，兼容这种差异

Codex 推荐：A
理由：当前更像历史异常数据，修改公共逻辑的影响范围更大。
```

用户确认：

> 先修复异常数据，不修改公共校验逻辑。

看板记录 Decision：

```yaml
decision: 修复当前异常草稿数据
reason: 避免扩大公共校验逻辑的影响范围
actor: wangfei
```

看板经用户确认后更新 Work Item：

```yaml
goal: 让指定 FBA 草稿恢复可创建状态
acceptance_criteria:
  - 草稿数据与领星实时数据一致
  - 草稿可以正常创建
  - 不影响其他货件
  - 留下修改前后证据
scope:
  allowed: 查询生产数据；修改指定草稿
  excluded: 不修改公共校验逻辑；不处理其他货件
next_action: 生成数据修复方案，执行前请求用户批准
version: 2
```

Codex 可以提出这些变更，但不能自行把建议变成用户决定或扩大后的范围。

## 6. 第二次启动：实施 Run 使用冻结快照

用户点击“开始执行”。看板基于 Work Item version 2 生成新的 Context Envelope：

```yaml
work_item:
  id: TASK-FBA-001
  version: 2
  goal: 让指定 FBA 草稿恢复可创建状态
  next_action: 生成数据修复方案，执行前请求用户批准
acceptance:
  criteria:
    - 草稿与领星数据一致
    - 草稿可以正常创建
    - 不影响其他货件
    - 保留修改前后证据
scope:
  allowed: 查询生产数据；修改指定草稿
  excluded: 不修改公共校验逻辑；不处理其他货件
decisions:
  - decision: 修复当前异常草稿数据
    reason: 避免扩大公共逻辑影响范围
recovery_point:
  current_conclusion: 草稿 SKU 与领星实时数据不一致
  completed:
    - 定位失败接口
    - 核对双方数据
  unresolved:
    - 尚未执行数据修复
  next_action: 生成数据修复方案
evidence_refs:
  - log://fba/20260807/123
  - artifact://lingxing/shipment-123.json
run:
  mode: implementation
  objective: 生成并执行指定草稿的数据修复
```

这份 Envelope 冻结在 Run 上。Work Item 后续变成 version 3，不会静默改变这个 Run 当时收到的目标和范围。

## 7. 多轮对话：临时讨论不能自动扩大范围

用户在执行对话里说：

> 顺便把其他类似草稿也一起修了吧。

Codex 应回答：

```text
当前 Run 只允许修改指定草稿。

批量修复其他草稿会扩大影响范围，需要：
1. 更新 Work Item 的目标、范围和验收标准并由用户确认；或
2. 创建独立的后续 Work Item。
```

如果用户只是讨论，没有确认看板变更：

- Work Item 不变。
- 当前 Run 的 Envelope 不变。
- Codex 不执行扩大后的工作。

任务发生关键变化时，产品必须展示变更；用户确认后创建新 Run，或明确向当前 Run 发送版本化范围更新。禁止静默注入。

## 8. 暂停：先留下 Recovery Point

当用户或 Codex 准备暂停、阻塞或切换主线时，看板要求保存：

```yaml
current_conclusion: 修复 SQL 已生成，尚未执行
completed:
  - 查明数据差异
  - 确定修改字段
  - 生成带条件限制的 SQL
  - 完成执行前查询
unresolved:
  - 需要用户批准生产修改
  - 需要执行后重新验证
next_action: 用户批准后执行 SQL，并进行后置查询
resource_refs:
  - sql://fba/fix-draft-123
  - snapshot://fba/before-123
```

没有 Recovery Point 时，看板拒绝把 Work Item 直接改为 `parked` 或 `blocked`。

Codex 可以生成和保存恢复摘要，但不能未经用户确认改变 Work Status。

## 9. 换新对话恢复

第二天用户点击“恢复”。看板创建新 Run，并从最新任务事实重建 Envelope：

```text
任务目标：修复指定 FBA 草稿
用户决定：只修指定草稿，不修改公共校验逻辑
当前状态：等待执行生产修复
已完成：SQL 和执行前查询已准备
未解决：尚未批准和执行
下一步：批准后执行 SQL，并进行后置验证
证据引用：修复 SQL、修改前快照、领星查询结果
```

新 Codex 对话不需要读取昨天的完整对话，就应能够说明：

```text
我已读取任务的最新 Context Envelope。当前应先展示待执行 SQL 和预计影响行数，取得用户批准后再执行生产修改。
```

如果信息不足，Codex 提交结构化上下文请求，例如：

```yaml
needed_context:
  - 草稿表结构
  - 当前校验代码位置
  - 领星字段定义
reason: 无法确认修复字段是否影响后续校验
```

看板只补充对应引用；需要扩大任务范围时仍由用户确认。

## 10. 相关性判断规则

新 Run 默认只接收：

1. 当前 Work Item 的最新目标、阶段、状态、范围、验收标准和下一步。
2. 当前 Work Item 已确认的 Decision。
3. 最新 Recovery Point。
4. 明确建立的 `parent`、`blocked_by`、`related` 关系。
5. 当前任务的证据引用和短摘要。
6. 本 Run 的目标、允许模式和预期输出。

默认不接收：

- 其他无关系任务。
- 全部历史 Work Item。
- 完整旧对话。
- 全部历史 Run 日志。
- 原始证据正文。
- 看板管家对话内容。

职责划分：

- 用户判断任务边界和业务相关性是否需要改变。
- 看板按 ID、关系、版本和恢复点确定必须提供的上下文。
- Codex 在批准范围内判断当前步骤需要读取哪个证据，并在不足时提出请求。

## 11. 实现状态

| 交互能力 | 当前状态 | 计划归属 |
| --- | --- | --- |
| Work Item 上下文字段 | 已实现 | M2 |
| Readiness 检查 | 已实现 API | M2 |
| 只读探索与实现模式 | 已实现 API | M2 |
| Context Envelope 生成 | 已实现 API | M2 |
| Run 保存冻结快照 | 已实现 | M2 |
| Decision、Recovery、关系、证据存储 | 已实现 API | M2 |
| 暂停前强制 Recovery Point | 已实现 API | M2 |
| 网页表单和操作按钮 | 未实现 | M4 任务详情；必要的执行入口可提前补齐 |
| 自动创建或恢复真实 Codex thread 并发送 Envelope | 已实现 API | M2 收口 |
| Codex turn 终态同步到 Run | 已实现 | M3.1 |
| Review Submission 结构化摘要 | 已实现 API | M3.1 |
| Codex 过程进展自动结构化回写 | 未实现 | M3 后续 |
| Decision Request 卡片与回答路由 | 未实现 | M3 |
| 人工通过、退回和创建后续任务 | 未实现 | M3 后续 |
| 今日工作台 | 未实现 | M4 |

## 12. 后续实现验收要求

任何后续 Codex 修改这条链路时，必须验证：

1. 新 Run 的输入可以追溯到明确的 Work Item version。
2. 新对话不读取旧对话全文，也能复述目标、范围、验收标准和下一步。
3. Work Item 更新不会改变旧 Run 快照。
4. 暂停后可以只靠最新 Recovery Point 恢复。
5. 范围扩大必须经过用户确认并留下审计。
6. SQLite 只保存结构化摘要和证据引用。
7. 未实现的交互不得在说明或页面中伪装成已上线能力。
