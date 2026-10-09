````skill
---
name: remember-this
description: Save something important to project memory. Use when the user says "remember this", "save this", "don't forget", "take note", "learn this", "add to memory", or when you discover something worth preserving for future sessions.
---

# Remember This

Save information to project memory so it persists across sessions.

## When to Use
- User says "remember this", "save this", "don't forget"
- You discover a pattern, workaround, or decision worth preserving
- User shares preferences, conventions, or project rules
- After solving a tricky problem

## Instructions

### 1. Classify the Information
- **Learning** → Something discovered through experience
- **Decision** → An architectural or design choice
- **Troubleshooting** → A problem and its solution
- **Preference** → How the user/team prefers to work
- **Fact** → A project-specific fact

### 2. Format for Storage
```
## [Concise Title]
**Date**: [today]  **Tags**: [keywords]  **Category**: [from above]
### What
[1-3 sentences]
### Why It Matters
[Brief context]
```

### 3. Save to Memory
Use `projectBrain_toolbox` with tool `writeMemory`:
- Learning/Decision → aspect: `learnings`
- Troubleshooting → aspect: `troubleshooting`
- Preference → aspect: `learnings` (tagged as preference)
- Fact → aspect: `overview` or `architecture`

### 4. Confirm
Tell the user what was saved and where, in plain language:
- "Saved to project memory under Learnings. I'll remember this next time."
- "Added to Troubleshooting. If this happens again, I'll know the fix."

## Examples
**User**: "Remember that we always use UTC for timestamps"
→ Save as Preference → "Got it — UTC for all timestamps. Saved to preferences."

**User**: "The deploy breaks if you forget to run migrations first"
→ Save as Troubleshooting → "Saved: run migrations before deploy. I'll warn you next time."
````
