```prompt
---
description: Get a narrative recap of what happened recently in the project
name: recap
tools: ["crismart.project-brain/toolbox", "search"]
---

Show what happened recently as a narrative, not a list.

## Steps
1. Search memory for "session handoff"
2. Search for recent learnings and troubleshooting entries
3. Synthesize into a story

## Output
Tell a story:
"Yesterday you worked on [feature]. You made [N] commits, mainly touching [area].
The last thing you did was [from handoff]. You left [N] files uncommitted.
Looks like you were in the middle of [task]. Want to continue?"
```
