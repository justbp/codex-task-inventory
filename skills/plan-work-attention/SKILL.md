---
name: plan-work-attention
description: Plan the user's next focus block from the live Codex Task Monitor board and optional personal constraints. Use when the user asks what to focus on, wants Codex work arranged around their attention, requests an hourly work recommendation, or schedules recurring attention planning.
---

# Plan Work Attention

Plan human attention, not just task priority. Separate what needs the user now from what Codex can continue doing in the background.

## Gather current facts

Always fetch a fresh compact board snapshot:

```bash
node <skill-dir>/../manage-codex-board/scripts/boardctl.mjs snapshot
```

Use only the returned compact fields. Never open complete Codex conversations or copy full logs into the planning context.

Also use personal constraints explicitly supplied by the user or scheduled prompt, such as:

- today's one to three desired outcomes;
- the time available before the next fixed commitment;
- deadlines and people currently blocked;
- work the user has already chosen as their main line.

If those constraints are absent, plan only Codex-related attention and say so when that limitation affects the recommendation. Do not invent deadlines, meetings, business impact, effort, or the user's energy level.

## Build the next focus block

Use this order:

1. Handle facts that require the user: waiting input, interruption, explicit errors, credible production or data risk, or another person being blocked.
2. Choose at most one human focus outcome for the next available block. Prefer work that closes a loop, fits the available time, and reuses the user's current project context.
3. Keep healthy active Codex tasks in the background. Recent progress is not a reason to interrupt the user.
4. At a task boundary, batch reviews from the same project. Review production deployments and data changes before ordinary analysis or design results.
5. Explicitly park unrelated upcoming work and low-value reviews so they do not occupy attention.
6. Name the next checkpoint: a time, task completion, waiting input, interruption, or an evidence-based stall.

Treat priority as user metadata, not proof of urgency. Treat a title/progress mismatch as a board-trust risk, not as evidence that either text is correct.

Ignore the current attention-planning automation and routine board-management runs unless they failed in a way that blocks future planning. Do not let the planner trigger itself.

## Write the recommendation

Keep the result readable in under one minute. Use this structure and omit empty sections:

```text
接下来 60 分钟

你的主线
<one concrete outcome and a bounded time block>

Codex 后台
<what can keep running without the user's attention>

完成后
<one next action at the boundary>

暂不关注
<the main distractions to park>

下次检查
<time or event trigger>

注意
<at most one material risk>
```

Do not lead with `继续`, `整理`, or `切换`. Do not output a status dump, exhaustive backlog, productivity score, or day-long plan.

If no Codex-related work deserves human attention, say that directly and protect the block for the user's existing main line instead of inventing board work.

After composing a materially new recommendation, publish the same compact content to the board's disposable display slot:

```bash
node <skill-dir>/../manage-codex-board/scripts/boardctl.mjs publish-advice \
  --attention-token TOKEN --headline HEADLINE --focus FOCUS \
  --background BACKGROUND --after AFTER --parked PARKED \
  --next-check NEXT_CHECK --risk RISK --primary-task-id TASK_ID
```

Omit optional fields that are empty. `headline` is the one-line outcome shown when the card is collapsed; `focus` is the bounded human focus block. Publishing this display state is allowed, but it must not alter any task or Codex conversation.

## Recurring runs

- Evaluate on schedule, but notify only when the user's recommended allocation changes or immediate intervention becomes necessary.
- Retain and compare the snapshot's opaque `attentionToken`, but do not equate token changes with actionable changes.
- Re-plan when personal time constraints or a planned checkpoint change, even if the board token does not.
- If neither the allocation nor a material risk changed, remain silent and do not republish the recommendation. A board surface may update its last-checked time without creating a new recommendation.
- Scheduled runs are read-only with respect to board items. Never create, start, edit, or complete tasks, and never change an existing Codex prompt.

## Keep product boundaries

This skill is an external, disposable planner. The board remains the source of Codex facts and the user remains responsible for task completion. Do not turn recommendations into persistent work items, automatic assignments, or an embedded AI management system.
