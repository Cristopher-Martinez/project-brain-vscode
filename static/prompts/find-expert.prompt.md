```prompt
---
description: Find who knows about a specific part of the project
name: find-expert
argument-hint: What topic? (e.g., "authentication", "database")
tools: ["crismart.project-brain/toolbox", "search"]
---

Help find the right person to ask about a topic.

## Steps
1. Search project memory for the topic
2. Search git insights for contributor data
3. Present: "For [topic], talk to [person] — they worked on [files] recently"
4. If no clear expert: "No single expert found. Most recent changes by..."
```
