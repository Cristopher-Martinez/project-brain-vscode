````skill
---
name: what-changed
description: Show what changed in the project recently. Use when the user asks "what changed?", "what happened?", "catch me up", "what did I miss?", "what's new?", "show recent changes", or at the start of a new session to provide context.
---

# What Changed

Provides a human-friendly summary of recent project changes.

## When to Use
- Start of a new session
- User asks "what changed?" or "catch me up"
- User returns after time away
- Before starting new work

## Instructions

### 1. Gather Change Data
Run these commands:
```bash
git branch --show-current
git log --oneline --since="24 hours ago" -n 10
git diff --stat HEAD~5
git status --short
git log -1 --format="%h %s (%cr)"
```

### 2. Search Session Memory
Search project memory for "session handoff" to find last session's state.

### 3. Present Summary
Format for non-programmers:
```
## What's Changed
**Branch**: `main` | **Last commit**: abc1234 (2 hours ago)

### Recent Work
1. Added user authentication (3 commits)
2. Fixed the login page bug
3. Updated dependencies

### Uncommitted Changes
- `src/auth.ts` — new login logic (not saved to git yet)

### Where You Left Off
[From session handoff]

### Suggested Next Steps
- [Based on uncommitted work and session state]
```

### 4. Offer Actions
- "Want me to explain any of these changes in detail?"
- "Ready to continue where you left off?"
````
