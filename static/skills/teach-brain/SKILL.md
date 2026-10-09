```skill
---
name: teach-brain
description: Teach the AI about your project conventions, patterns, and preferences. Use when the user says "from now on", "always do X", "never do Y", "our convention is", "we prefer", "the rule is", or wants to establish a project standard.
---

# Teach Brain

Lets users establish project rules and conventions that the AI remembers and follows.

## When to Use
- User establishes a convention: "from now on, always..."
- User corrects AI behavior: "don't do X, do Y instead"
- User shares team practices: "our convention is..."
- User wants consistent behavior across sessions

## Instructions

### 1. Parse the Teaching
Extract:
- **Rule**: What should always/never happen
- **Scope**: All files, specific languages, specific folders?
- **Strength**: Hard rule or preference?

### 2. Check for Conflicts
Search memory for existing opinions/preferences that might conflict. If conflict found, ask user which takes priority.

### 3. Store Appropriately
- **Hard rules** (always/never) → `writeMemory` aspect: `learnings` + note as high-confidence rule
- **Preferences** (we prefer) → `writeMemory` aspect: `learnings` + note as preference
- **Conventions** (our convention) → `writeMemory` aspect: `learnings` + note as convention

### 4. Confirm Understanding
Repeat the rule back:
- "Understood: always use arrow functions. I'll follow this in all future code."
- "Got it: error messages in Spanish. Saved as project convention."

## Examples
**User**: "From now on, always add JSDoc to exported functions"
→ Save as rule → "Rule saved: all exported functions get JSDoc. I'll add them automatically."

**User**: "We prefer Tailwind over inline styles"
→ Save as preference → "Noted: Tailwind preferred. I'll suggest Tailwind when styling."
```
