# Repository instructions

## Codex Workbench design

Before planning or implementing changes involving work items, Codex runs, board-manager AI, task states, review, recovery, context assembly, or task/thread relationships:

1. Read `docs/CODEX_WORKBENCH_DESIGN.md` completely.
2. State which numbered product invariants (`I-01` through `I-15`) the change touches.
3. Include verification that those invariants remain satisfied.
4. Stop and ask the user before changing or contradicting an invariant.

Do not treat a Codex thread as the source of truth for a work item. Do not allow Codex self-verification to move a work item directly to `done`.
