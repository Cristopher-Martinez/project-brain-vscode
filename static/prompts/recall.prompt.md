```prompt
---
description: Search project memory with natural language — ask anything about the project
name: recall
argument-hint: What do you want to know? (e.g., "how does auth work?")
tools: ["crismart.project-brain/toolbox", "search", "read"]
---

The user wants to search project memory. Use `projectBrain_toolbox` with tool `searchMemory` to find relevant information.

## Instructions
1. Take the user's question and search project memory
2. If the first search doesn't find enough, try different keywords
3. Present results in plain language — no technical jargon unless the user used it
4. If memory doesn't have the answer, say so and offer to search the codebase

## Response Format
Keep it conversational:
- "Here's what I know about [topic]..."
- "Based on project memory, [answer]"
- "I don't have this in memory yet. Want me to look into the code?"

Do NOT show raw search results. Synthesize them into a natural answer.
```
