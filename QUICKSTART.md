# Project Brain - Quick Start

## Installation (Development)

### Method 1: Direct Install (Recommended)

```powershell
# In VS Code, press F5 to launch Extension Development Host
# Or run:
code --extensionDevelopmentPath="<path-to-project-brain>"
```

### Method 2: Manual Install

1. Open VS Code
2. Press `Ctrl+Shift+P`
3. Type: `Developer: Install Extension from Location`
4. Select: `<path-to-project-brain>`
5. Reload VS Code

### Method 3: Package as VSIX

```powershell
cd <path-to-project-brain>
npm run package
code --install-extension project-brain-0.1.0.vsix
```

## Testing

1. Open any project in VS Code
2. Press `Ctrl+Shift+P`
3. Type: `Project Brain: Initialize Project Memory`
4. Follow the prompts

## What It Does

- Creates `.project-brain/memory/` with initial documentation
- Generates `AGENTS.md` for AI agent guidelines
- Configures `.vscode/mcp.json` for RAG integration
- Scans your codebase and indexes with RAG
- Enables `search_memory` tool for Copilot

## Commands

- `Project Brain: Initialize Project Memory` - Bootstrap project
- `Project Brain: Scan and Update Documentation` - Re-scan
- `Project Brain: Show Status` - View stats
- `Project Brain: Open Memory Folder` - Quick access

## Development

```powershell
# Watch mode
npm run watch

# Launch extension dev host
# Press F5 in VS Code
```

## Files Created

```
your-project/
├── .project-brain/memory/
│   ├── 00_PROJECT_OVERVIEW.md    (auto-generated)
│   ├── 01_ARCHITECTURE.md        (auto-generated)
│   ├── 02_CODE_MAP.md            (auto-generated)
│   ├── 03_DEPENDENCIES.md        (auto-generated)
│   └── archive/
├── .vscode/
│   └── mcp.json                  (MCP configuration)
└── AGENTS.md                     (AI guidelines)
```

## Next Steps

After initialization:

1. Edit the generated docs to add project-specific details
2. The RAG watcher (from your MCP server) will auto-sync changes
3. AI agents can now use `search_memory` to query your docs
