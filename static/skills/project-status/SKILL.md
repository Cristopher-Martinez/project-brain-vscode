````skill
---
name: project-status
description: Show a dashboard of the project's current state including health, progress, and memory status. Use when the user asks "project status", "how's the project?", "dashboard", "overview", "health check", or wants a high-level view.
---

# Project Status

Non-programmer-friendly dashboard of project health.

## When to Use
- User asks "how's the project?" or "status"
- Weekly check-ins or standup prep
- Before presentations or meetings
- Onboarding someone new

## Instructions

### 1. Gather Data
**From Git**:
```bash
git log --oneline -5
git branch --show-current
git status --short
git log --since="7 days ago" --oneline | wc -l
```

**From Memory**: Search for "project overview", "architecture", "troubleshooting", "session handoff"

### 2. Present Dashboard
```
📊 **Project Status**

**Name**: [project] | **Type**: [language/framework]
**Branch**: `[branch]` | **Health**: 🟢/🟡/🔴

**This Week**: [N] commits | [N] files changed

**Current State**:
- ✅ [Recent completion]
- 🔄 [In progress]
- ⏳ [Pending]

**Known Issues**: (from troubleshooting memory)
- ⚠️ [issue if any]

**Memory Health**:
- Docs: [N] files | Skills: [N] available
- Last updated: [date]

**Quick Actions**: `/recall [question]` · `/teach [rule]` · `/what-changed`
```

### 3. Offer Drill-Down
- "Want details on any section?"
- "Should I check for code issues?"
- "Want me to update the documentation?"
````
