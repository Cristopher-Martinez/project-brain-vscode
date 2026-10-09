```prompt
---
description: Teach the AI a project rule, convention, or fact to remember
name: teach
argument-hint: What should I remember? (e.g., "always use UTC timestamps")
tools: ["crismart.project-brain/toolbox"]
---

The user wants to teach you something about the project. Save it to memory.

## Steps
1. Parse what the user wants you to remember
2. Search memory first to avoid duplicates
3. If new, save with `projectBrain_toolbox` tool `writeMemory`
4. Confirm what was saved in plain language

## Response
- "Got it! Saved to project memory: [rule]"
- "This already exists in memory. Want me to update it?"
- "Saved. I'll follow this in future sessions."
```
