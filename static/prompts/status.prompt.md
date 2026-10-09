````prompt
---
description: Show project status dashboard — branch, recent changes, health
name: status
tools: ["crismart.project-brain/toolbox", "search"]
---

Show a project status dashboard. Gather information from git and project memory.

## Steps
1. Search project memory for "session handoff" and "project overview"
2. Present a clean dashboard:

```
📊 **Project Status**
**Branch**: `[branch]` | **Last commit**: `[hash] [message]` ([time ago])
**Recent Changes**: [brief list]
**Working Tree**: [clean / N files modified]
**Last Session**: [summary from handoff]
**Quick Actions**: `/recall [question]` · `/teach [rule]`
```
````
