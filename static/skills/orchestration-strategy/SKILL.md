---
name: orchestration-strategy
description: Decision framework for choosing ModelRouter slaves (cheap LLMs) vs runSubagent (Copilot context windows). Use when delegating work, splitting tasks by cost/complexity, optimizing tokens, or deciding between fast grunt work and deep codebase research.
category: core
tier: free
version: 1.0.0
author: project-brain
official: true
---

# Orchestration Strategy — Slaves vs Subagents

## Overview
Project Brain has TWO delegation systems. Using the wrong one wastes resources or leads to failed tasks. Each tool has its place.

## The Two Systems

### 🔗 ModelRouter Slaves (`delegateTask`)
- **What**: Cheap LLMs (free/cheap tier) invoked via VS Code LM API
- **Context**: Only receive prompt + refined system prompt. NO conversation history
- **Tools**: Only sandboxed powers (read-file, list-dir, search-text, read-lines, file-exists, get-symbols, count-lines)
- **Cannot**: Edit files, run terminal, do git, use VS Code tools, browse web
- **Cost**: $0 (free tier) or very low (cheap)
- **Speed**: 1-3 seconds
- **Validation**: Output auto-validated, retry up to 3x, escalation on failure
- **When to use**: TEXT TRANSFORMATION tasks — input → output with no side effects

### 🤖 Subagents (`runSubagent`)
- **What**: Full Copilot instances with their own context window
- **Context**: Receive ONLY what you pass in the prompt (stateless). NO history
- **Tools**: ALL — read_file, replace_string_in_file, run_in_terminal, grep_search, semantic_search, create_file, git, etc.
- **Can**: Read files, edit code, run commands, search codebase, create files
- **Cost**: Uses current agent's model (generally ultra/premium)
- **Speed**: 5-30 seconds (more tools = more time)
- **Validation**: Manual — you verify what they return
- **When to use**: Tasks that require WORKSPACE ACCESS — read, write, search, execute

## Decision Matrix

| Task | Slave | Subagent | Why |
|------|-------|----------|-----|
| Summarize text | ✅ | ❌ | Pure transformation, no workspace needed |
| Generate simple function | ✅ | ❌ | Input→output, slave with powers can read context |
| Code review of snippet | ✅ | ❌ | Code goes in the prompt |
| Reformat/list data | ✅ | ❌ | Pure transformation |
| Classify/categorize | ✅ | ❌ | Simple input→output |
| Read 3+ files and report | ❌ | ✅ | Needs full read tools |
| Update 3+ memory files | ❌ | ✅ | Needs replace_string_in_file |
| Investigate codebase | ❌ | ✅ | Needs grep_search, semantic_search, read_file |
| Generate project-dependent code | 🟡 | ✅ | Slave can with powers, but subagent is more precise |
| Create source map of large file | ❌ | ✅ | Needs to read full file + create content |
| Compile and verify | ❌ | ✅ | Needs run_in_terminal |
| Git operations | ❌ | ✅ | Needs terminal |
| Multi-file refactoring | ❌ | ✅ | Needs edit + compile + verify |
| Debug errors | ❌ | ✅ | Needs read errors, search code, test fixes |

## General Rule

```
Does the task need to READ or WRITE workspace files?
  → YES → Subagent
  → NO → Is it text transformation (input → output)?
           → YES → Slave (free or cheap)
           → NO → Evaluate case by case
```

## When to Combine Both

### Pattern: Research → Transform → Apply
1. **Subagent** investigates (reads files, finds patterns, reports findings)
2. **Brain** (main agent) decides what to do with findings
3. **Slave** transforms (summarizes, generates code, formats)
4. **Brain** applies the result to workspace

### Pattern: Bulk Processing
1. **Subagent** collects data (reads N files, extracts info)
2. **Slave** processes each item (summarizes, classifies, formats) — free
3. **Brain** consolidates and writes final result

### Pattern: Quality Gate
1. **Slave** generates output (code, docs, review)
2. **Brain** validates (ModelRouter does this automatically)
3. If fails → **Slave** retries (automatic retry loop)
4. If still fails → escalation to better model
5. If result needs applying → **Subagent** applies it to workspace

## Anti-Patterns

| Error | Why it's bad | Fix |
|-------|-------------|-----|
| Use subagent to summarize text | Wastes expensive model + context window | Slave free |
| Use slave to edit files | Doesn't have tools for that | Subagent |
| Use slave to investigate codebase | Limited powers, no full grep_search | Subagent |
| Don't delegate when 3+ files | Main context overflows | Delegate |
| Send slave without taskKind | Doesn't get specialist persona or rules | Always pass taskKind |
| Send subagent without enough context | Stateless — knows nothing | Include EVERYTHING in prompt |

## Integration with Context Management

This skill complements `context-management`. The rule is:

1. **context-management** says WHEN to delegate (>3 files, >500 lines, >5 tool calls)
2. **orchestration-strategy** says TO WHOM to delegate (slave vs subagent)

Combined flow:
```
Task arrives → Do I need to delegate? (context-management)
  → NO → Do it directly
  → YES → To whom? (orchestration-strategy)
         → Pure transformation → Slave (delegateTask)
         → Needs workspace → Subagent (runSubagent)
         → Both → Combine (research → transform → apply)
```

## Notes
- Slaves are FREE on free tier. Use them aggressively for transformations.
- Subagents use expensive models. Use them only when tools are needed.
- ModelRouter already has retry + escalation + validation. Don't reimplement for subagents.
- Subagents do NOT know conversation history. Include ALL context in the prompt.
- Never delegate architectural decisions — that's Brain work (ultra tier).
