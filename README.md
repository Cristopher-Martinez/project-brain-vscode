# Project Brain - VS Code Extension

Transform any project into a self-documenting, RAG-powered intelligent codebase.

> **Portfolio reference.** Built between February and June 2026 and kept as a snapshot. It is not maintained, and issues and pull requests are not monitored. The hosted server behind the cloud features is not part of this repository.
>
> **Why it exists.** I wanted to spend fewer tokens in VS Code. Project Brain gives coding agents a permanent memory that grows with the project, built from its own documents indexed as vectors and embeddings. Hooks and gates around the agents' iterations came later, to catch mistakes and keep them on the intended path. The first commit is from February 2026, about two months after VS Code first shipped Agent Skills as an experimental feature.

## Features

- 🧠 **Auto-Initialize Memory**: One-click setup of project documentation structure
- 📊 **Smart Scanning**: Automatically detects project type and generates initial docs
- 🔍 **RAG Integration**: Connects to Model Context Protocol (MCP) for semantic search
- 📝 **Living Documentation**: Keep docs in sync with your codebase
- 🤖 **AI-Ready**: Optimized for GitHub Copilot and other AI coding assistants

## Quick Start

1. Install the extension
2. Open your project
3. Run command: `Project Brain: Initialize Project Memory`
4. Done! Your project now has memory.

## What It Creates

```
your-project/
├── .project-brain/memory/
│   ├── 00_PROJECT_OVERVIEW.md
│   ├── 01_ARCHITECTURE.md
│   ├── 02_CODE_MAP.md
│   ├── 03_DEPENDENCIES.md
│   └── archive/
├── .vscode/
│   └── mcp.json              # MCP RAG configuration
└── AGENTS.md                 # Guidelines for AI agents
```

## Requirements

- VS Code 1.85.0 or higher
- Node.js 18+ (for MCP server)

## Extension Settings

This extension contributes the following settings:

### `projectBrain.memoryFolder`

- **Default:** `".project-brain/memory"`
- **Description:** Path to the memory folder relative to workspace root

{
"projectBrain.memoryFolder": "documentation/brain"

````

### `projectBrain.mcpServerPath`
- **Type:** `string`
- **Default:** `""` (auto-detect)
- **Description:** Absolute path to the MCP RAG server installation

**Example:**

```json
{
}
````

**When to set manually:**

- MCP server is in a non-standard location
- Using a custom/forked version of the RAG server
- Auto-detection fails
- **Type:** `boolean`
- **Default:** `true`
- **Description:** Automatically prompt to initialize when opening a project without memory

- `false`: Silent mode, must manually run Initialize command

**Use case:** Set to `false` if you work on many temporary/example projects

- **Enum:** `["auto", "cloudflare", "openai", "tfidf"]`
- **Default:** `"auto"`
- **Description:** Embedding provider for semantic search
  **Options:**

|----------|------|------|--------------|
| **cloudflare** | Fast, scalable, pay-per-use | Needs API key | Project Brain account |
| **openai** | High quality, no setup | Costs money, needs API key | OpenAI account |
| **tfidf** | No dependencies, fast | Lower quality search | None |

1. **Default:** `auto` (Cloudflare > OpenAI > TF-IDF)
2. **Fallback:** `tfidf` (always works)

### Configuration Example

Add to your `.vscode/settings.json`:

{
"projectBrain.mcpServerPath": "",
"projectBrain.autoScan": true,

}

```

## Commands

### 🧠 Project Brain: Initialize Project Memory

**What it does:**

- Detects your project type (React, Node.js, Python, Rust, Go, etc.)
- Creates a standardized memory structure in `.project-brain/memory/`
- Generates initial documentation by analyzing your codebase

- Indexes all documentation for instant searchability
**When to use:**

- First time setting up Project Brain in a new project
- When starting a project without documentation
- When you want AI assistants to have full project context

**Example workflow:**

1. Open your project in VS Code
2. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
3. Type: `Project Brain: Initialize`
4. Press Enter and wait ~10-30 seconds
5. ✅ Your project now has memory!

**What gets created:**

```

your-project/
├── .project-brain/memory/
│ ├── 00_PROJECT_OVERVIEW.md ← Auto-generated from README

│ ├── 02_CODE_MAP.md ← Key files and modules
│ ├── 03_DEPENDENCIES.md ← From package.json/requirements.txt
├── .vscode/
│ └── mcp.json ← MCP RAG configuration
└── AGENTS.md ← Guidelines for AI agents

```


---

### 🔄 Project Brain: Scan and Update Documentation

**What it does:**

- Re-scans your entire codebase
- Detects new files, folders, and dependencies
- Re-indexes with RAG for fresh semantic search
- Preserves manual edits in documentation files

- After major refactoring or restructuring
- Periodically (weekly/monthly) to keep docs fresh

**Example:**

Before scan:

- Installed 5 new npm packages
- Reorganized components/

After scan:


```

1. Press `Ctrl+Shift+P`
2. Type: `Project Brain: Scan`

3. Wait for completion (~5-15 seconds)

---

### 📊 Project Brain: Show Status

**What it does:**

- Displays current state of Project Brain in your project
- Shows RAG index statistics (chunks, files, last update)
- Verifies MCP server connection
- Reports memory structure health

**Information displayed:**

## Project Brain Status

Memory Structure: ✅ Active
MCP RAG Server: ✅ Configured
Last Updated: 2026-02-01 12:34:56

Embedding Provider: Cloudflare Workers AI

```

**When to use:**

- Debugging RAG search issues
- Verifying setup after initialization

- Checking if documentation is up-to-date
- Monitoring index size and health

**How to run:**

1. Press `Ctrl+Shift+P`
2. Type: `Project Brain: Status`
3. View the status panel

---

**What it does:**

- Opens the `.project-brain/memory/` folder in VS Code explorer

- Provides quick access to all documentation files
- Opens the first memory file in the editor

**When to use:**

- Manually editing documentation
- Reviewing auto-generated content

- Adding project-specific details
- Organizing archived docs


---

## Keyboard Shortcuts

You can assign custom shortcuts to commands:

1. Press `Ctrl+K Ctrl+S` to open Keyboard Shortcuts
2. Search for "Project Brain"
3. Assign your preferred shortcuts

**Suggested shortcuts:**

- `Ctrl+Alt+B I` → Initialize
- `Ctrl+Alt+B S` → Scan
- `Ctrl+Alt+B O` → Open Memory

## How It Works

### 1. **Bootstrap Phase** (Project Brain: Initialize)


```

Step 1: Detect project type
├─ Scans for package.json (Node.js/React/Next.js)
├─ Checks requirements.txt (Python)
├─ Looks for Cargo.toml (Rust)
└─ Identifies Go.mod (Go)

Step 2: Create memory structure
├─ Creates .project-brain/memory/ folder
├─ Generates AGENTS.md with AI guidelines
└─ Sets up .vscode/mcp.json for RAG

Step 3: Scan codebase
├─ Reads README.md for project overview

├─ Analyzes folder structure (src/, lib/, components/)
├─ Maps key files and modules
└─ Extracts dependencies

Step 4: Generate documentation
├─ 00_PROJECT_OVERVIEW.md (from README + detection)
├─ 01_ARCHITECTURE.md (from folder structure)
├─ 02_CODE_MAP.md (from file scan)
└─ 03_DEPENDENCIES.md (from package.json/requirements.txt)

Step 5: Index with RAG
├─ Connects to MCP RAG server
├─ Generates embeddings (Cloudflare Workers AI or TF-IDF)
├─ Creates searchable vector index
└─ Enables search_memory tool for AI

````

### 2. **Continuous Learning**

After initialization, Project Brain stays synchronized:

- **Auto-watch:** The MCP RAG watcher monitors `.project-brain/memory/` for changes
- **Auto-index:** Any edit to memory files triggers re-indexing (within 5s)
- **Manual rescan:** Run "Scan and Update" when you want to refresh from code

### 3. **AI Integration**

Once initialized, AI assistants (like GitHub Copilot) can:

```typescript
// AI agents can now use:
search_memory("how does authentication work?")
// Returns: Relevant chunks from your documentation

search_memory("tenant isolation architecture")
// Returns: Architecture decisions and implementation details

search_memory("what dependencies handle WebSocket?")
// Returns: Dependency info and related code patterns
````

**Behind the scenes:**

- Copilot sends queries to MCP RAG server
- Server performs hybrid search (semantic + keyword)
- Returns top 5 most relevant chunks with context
- Copilot uses this to answer with project-specific knowledge

## MCP Integration

This extension integrates with the **MCP RAG server** to provide semantic search over your project documentation.

### What is MCP?

### How the Integration Works

```
┌─────────────┐         ┌──────────────┐         ┌─────────────┐
│   VS Code   │         │  MCP Server  │         │ Cloudflare  │
│   Copilot   │────────▶│  (RAG Docs)  │────────▶│ Workers AI  │
│             │◀────────│              │◀────────│             │
└─────────────┘         └──────────────┘         └─────────────┘
     │                         │

     │                         │
     └─────────────────────────┴─────────────────────┐
                                                     │
                                          │  .project-brain/memory/     │
                                          │  - 00_*.md        │
                                          │  - 01_*.md        │
                                          │  - 02_*.md        │

### Features Enabled by MCP

- Query: "authentication" → Finds auth, login, security, JWT
- Query: "database" → Finds DB, storage, persistence, queries

1. **Query Expansion:** Domain-specific term mapping
   - "tenant" → also searches "multi-tenant, isolation, namespace"
   - "gateway" → also searches "router, proxy, middleware"

2. **File Filtering:** Scope searches to specific docs
   - `search_memory("architecture", filter="01_ARCHITECTURE")`

3. **Hybrid Scoring:** Combines semantic + keyword matching
   - Exact phrase matches get +15% boost
   - Section header matches get +5% boost

### Configuration

 extension auto-configures `.vscode/mcp.json`:

1
servers": {
 "rag-docs": {
      "command": "node",
1 }
}
3
**Auto-detection paths:**
2 `~/mcp-servers/rag-docs`
- `C:\Users\{user}\mcp-servers\rag-docs`

3f not found, the extension will prompt you to:

1. Install the MCP server
2. Specify a custom path
### Using Without MCP

You can still use Project Brain without MCP:

- ✅ Memory structure creation works
- ✅ Documentation generation works
- ✅ Manual edits to memory files
- ❌ No AI-powered semantic search
- ❌ Copilot won't have project context

## License

MIT

## Contributing

Contributions welcome! This is an MVP - lots of room for improvement.
```
