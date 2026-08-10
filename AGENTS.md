# Repository instructions

## Product boundary

Before changing task capture, Codex launch, monitoring, review, notifications, or completion behavior:

1. Read `docs/CODEX_WORKBENCH_DESIGN.md` completely.
2. State which product invariants (`I-01` through `I-06`) the change touches.
3. Verify the simple capture → monitor → intervene → review path remains usable.
4. Stop and ask the user before contradicting an invariant.

Keep this product a lightweight Codex task monitor. An external skill may read the board and use existing actions after explicit user instruction. Do not introduce Work Item, Run, Context Envelope, Recovery Point, Decision Request, WIP, or an embedded AI management system unless the user explicitly changes the product boundary.
