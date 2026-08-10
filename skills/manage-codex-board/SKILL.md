---
name: manage-codex-board
description: Review and manage the local Codex Task Monitor board. Use when the user asks what needs attention, requests project or task prioritization, wants to capture a board item, explicitly asks to start a Codex subtask, or schedules a recurring board review.
---

# Manage Codex Board

Use the board as the source of current task status. Keep each management conversation disposable: read a fresh compact snapshot instead of relying on chat history.

## Read the board

Run:

```bash
node <skill-dir>/scripts/boardctl.mjs snapshot
```

Use only the returned compact fields. Do not open complete Codex conversations or copy full logs into the management context.

Report briefly in this order:

1. Items needing the user: waiting, interrupted, or awaiting review.
2. Active work and apparent stalls.
3. At most three recommended next actions with reasons.

If nothing materially needs attention, say so without inventing work.

## Capture an item

Only create an item when the user explicitly asks to record, add, or remember it:

```bash
node <skill-dir>/scripts/boardctl.mjs create --title "..." --note "..." --project "..." --cwd "/absolute/path" --lane inbox
```

Preserve the user's title and note. Do not silently add goals, scope, acceptance criteria, or a plan.

## Start a subtask

Only start work when the user explicitly says to start, launch, begin, or hand the task to Codex.

Start an existing upcoming item:

```bash
node <skill-dir>/scripts/boardctl.mjs start --id "..."
```

Or create and start in one action:

```bash
node <skill-dir>/scripts/boardctl.mjs dispatch --title "..." --note "..." --project "..." --cwd "/absolute/path"
```

Require an existing absolute working directory. If it is missing or ambiguous, ask the user instead of guessing. Return the launched Codex link.

## Safety boundaries

- Treat scheduled and unattended runs as read-only. Never create or start tasks from a scheduled run.
- Do not mark review items complete; completion always belongs to the user.
- Do not modify the goal or prompt of an existing Codex task.
- Keep the management conversation separate from launched task conversations.
- Use `CODEX_TASK_MONITOR_URL` only when the monitor is not at `http://127.0.0.1:47824`.
