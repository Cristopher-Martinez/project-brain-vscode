---
description: Pick an implementation strategy before starting a task — ranks options using keyword matching + knowledge graph
name: strategy
argument-hint: "task description [--strategy-name]" (e.g., "implement auth --tdd-first")
---

The user wants to pick an implementation strategy before starting work on a task.

## Syntax

- `/strategy <task>` — Show ranked strategies via native quick pick, then refinement questions
- `/strategy <task> --<strategy-hint>` — Auto-select the strategy matching the hint (fuzzy match), skip quick pick

## Instructions

### Without `--` (interactive mode)

1. Call `projectBrain_toolbox` with `{ "tool": "strategyPicker", "task": "{{input}}" }`. Do NOT set `selectedStrategy`.
2. The tool will show a **native VS Code quick pick** — the user selects directly. No need to call `ask_questions`.
3. After selection, refinement questions appear as **native input boxes**.
4. The tool returns the complete strategy instruction with user context. Follow it VERBATIM.

### With `--` (direct mode)

1. Extract the task (before `--`) and the strategy hint (after `--`).
2. Call `projectBrain_toolbox` with `{ "tool": "strategyPicker", "task": "<task>", "selectedStrategy": "<strategy-hint>" }`.
3. The tool fuzzy-matches the hint, shows refinement input boxes, and returns the procedure. Follow it VERBATIM.

## Rules

- The tool handles ALL user interaction natively (quick pick + input boxes). You just call it once.
- NEVER start implementing before the strategy procedure is loaded.
- Follow the returned procedure VERBATIM — do not summarize or simulate.
