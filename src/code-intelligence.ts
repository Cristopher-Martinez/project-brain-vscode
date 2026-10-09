import * as path from "path";
import * as vscode from "vscode";

// ─── Interfaces ──────────────────────────────────────────────────────────────

/** A symbol extracted from the codebase via Language Services */
export interface CodeSymbol {
  name: string;
  kind: string; // 'class', 'function', 'interface', 'enum', 'variable', 'method', 'property'
  file: string; // workspace-relative path
  line: number;
  /** Exported from the module? */
  exported: boolean;
  /** Brief detail (e.g., return type, extends clause) */
  detail: string;
  /** Child symbols (methods of a class, properties of an interface) */
  children: { name: string; kind: string; detail: string }[];
}

/** Import relationship between two files */
export interface ImportEdge {
  from: string; // importer (workspace-relative)
  to: string; // imported module (workspace-relative or package name)
  symbols: string[]; // what was imported
  isExternal: boolean;
}

/** Module summary for a single file */
export interface ModuleSummary {
  file: string;
  exports: string[];
  imports: ImportEdge[];
  symbols: CodeSymbol[];
  lineCount: number;
  /** Complexity estimate: number of top-level symbols */
  complexity: number;
}

/** Full code intelligence report */
export interface CodeIntelligenceReport {
  modules: ModuleSummary[];
  internalDependencyGraph: ImportEdge[];
  externalDependencies: string[];
  /** Top-level public API: exported classes, functions, interfaces */
  publicAPI: CodeSymbol[];
  /** Complexity ranking: files sorted by symbol count */
  complexityRanking: { file: string; symbolCount: number; lineCount: number }[];
  /** Detected API endpoints (Express/Fastify/Next.js routes) */
  apiEndpoints: APIEndpoint[];
}

export interface APIEndpoint {
  method: string; // GET, POST, PUT, DELETE, etc.
  path: string;
  file: string;
  line: number;
  handler: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SUPPORTED_LANGUAGES = new Set([
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
  "python",
  "go",
  "rust",
  "java",
  "csharp",
]);

const MAX_FILES_TO_ANALYZE = 200;
const FILE_ANALYSIS_TIMEOUT_MS = 5000;

const SYMBOL_KIND_MAP: Record<number, string> = {
  [vscode.SymbolKind.Class]: "class",
  [vscode.SymbolKind.Function]: "function",
  [vscode.SymbolKind.Interface]: "interface",
  [vscode.SymbolKind.Enum]: "enum",
  [vscode.SymbolKind.Variable]: "variable",
  [vscode.SymbolKind.Constant]: "constant",
  [vscode.SymbolKind.Method]: "method",
  [vscode.SymbolKind.Property]: "property",
  [vscode.SymbolKind.Constructor]: "constructor",
  [vscode.SymbolKind.Module]: "module",
  [vscode.SymbolKind.Namespace]: "namespace",
  [vscode.SymbolKind.TypeParameter]: "type-parameter",
  [vscode.SymbolKind.Struct]: "struct",
  [vscode.SymbolKind.Event]: "event",
  [vscode.SymbolKind.Operator]: "operator",
};

// ─── CodeIntelligenceAnalyzer ────────────────────────────────────────────────

export class CodeIntelligenceAnalyzer {
  constructor(private workspaceFolder: vscode.WorkspaceFolder) {}

  /**
   * Run full semantic analysis using VS Code Language Services.
   * This leverages whatever language server is active (TypeScript, Python, etc.)
   * to extract real symbols, imports, and exports.
   */
  async analyze(
    progress?: (msg: string) => void,
  ): Promise<CodeIntelligenceReport> {
    const report: CodeIntelligenceReport = {
      modules: [],
      internalDependencyGraph: [],
      externalDependencies: [],
      publicAPI: [],
      complexityRanking: [],
      apiEndpoints: [],
    };

    const rootPath = this.workspaceFolder.uri.fsPath;
    const files = await this.findSourceFiles();

    progress?.(`Analyzing ${files.length} source files...`);

    // Process files in batches to avoid overwhelming the language server
    const BATCH_SIZE = 10;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map((file) => this.analyzeFile(file, rootPath)),
      );

      for (const result of batchResults) {
        if (result.status === "fulfilled" && result.value) {
          report.modules.push(result.value);
        }
      }

      if (i % 50 === 0 && i > 0) {
        progress?.(`Analyzed ${i}/${files.length} files...`);
      }
    }

    // Build dependency graph from collected imports
    const allInternalFiles = new Set(report.modules.map((m) => m.file));
    const externalDeps = new Set<string>();

    for (const mod of report.modules) {
      for (const imp of mod.imports) {
        if (imp.isExternal) {
          // Extract package name (handle scoped packages like @scope/pkg)
          const parts = imp.to.split("/");
          const pkgName =
            imp.to.startsWith("@") && parts.length > 1
              ? `${parts[0]}/${parts[1]}`
              : parts[0];
          externalDeps.add(pkgName);
        } else {
          report.internalDependencyGraph.push(imp);
        }
      }
    }

    report.externalDependencies = Array.from(externalDeps).sort();

    // Extract public API (exported symbols)
    report.publicAPI = report.modules
      .flatMap((m) => m.symbols.filter((s) => s.exported))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Complexity ranking
    report.complexityRanking = report.modules
      .map((m) => ({
        file: m.file,
        symbolCount: m.complexity,
        lineCount: m.lineCount,
      }))
      .sort((a, b) => b.symbolCount - a.symbolCount);

    // API endpoint detection
    report.apiEndpoints = await this.detectAPIEndpoints(report.modules);

    return report;
  }

  // ─── File Discovery ─────────────────────────────────────────────────

  private async findSourceFiles(): Promise<vscode.Uri[]> {
    const pattern = new vscode.RelativePattern(
      this.workspaceFolder,
      "**/*.{ts,tsx,js,jsx,py,go,rs,java,cs}",
    );

    const excludePattern =
      "{**/node_modules/**,**/dist/**,**/build/**,**/.git/**,**/vendor/**,**/__pycache__/**,**/target/**,**/bin/**,**/obj/**,**/.next/**,**/.nuxt/**,**/coverage/**,**/.vscode-test/**,**/.vscode/**,**/out/**}";

    const files = await vscode.workspace.findFiles(
      pattern,
      excludePattern,
      MAX_FILES_TO_ANALYZE,
    );

    return files.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
  }

  // ─── Per-File Analysis ──────────────────────────────────────────────

  private async analyzeFile(
    fileUri: vscode.Uri,
    rootPath: string,
  ): Promise<ModuleSummary | null> {
    const relativePath = path
      .relative(rootPath, fileUri.fsPath)
      .replace(/\\/g, "/");

    try {
      // Open document to trigger language server
      const doc = await vscode.workspace.openTextDocument(fileUri);

      if (!SUPPORTED_LANGUAGES.has(doc.languageId)) {
        return null;
      }

      // Get symbols via Language Services (DocumentSymbolProvider)
      const rawSymbols = await this.getDocumentSymbols(fileUri);
      const symbols = this.processSymbols(rawSymbols, relativePath, doc);

      // Parse imports from source text
      const imports = this.extractImports(doc, relativePath, rootPath);

      // Detect exports
      const exports = symbols.filter((s) => s.exported).map((s) => s.name);

      const lineCount = doc.lineCount;

      return {
        file: relativePath,
        exports,
        imports,
        symbols,
        lineCount,
        complexity: symbols.filter((s) =>
          ["class", "function", "interface", "enum"].includes(s.kind),
        ).length,
      };
    } catch {
      // Language server not available or file unreadable — skip silently
      return null;
    }
  }

  /**
   * Get document symbols with timeout protection.
   * Falls back to empty array if the language server is slow or absent.
   */
  private async getDocumentSymbols(
    uri: vscode.Uri,
  ): Promise<vscode.DocumentSymbol[]> {
    try {
      const result = await Promise.race([
        vscode.commands.executeCommand<
          (vscode.DocumentSymbol | vscode.SymbolInformation)[]
        >("vscode.executeDocumentSymbolProvider", uri),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), FILE_ANALYSIS_TIMEOUT_MS),
        ),
      ]);

      if (!result) return [];

      // Convert SymbolInformation to DocumentSymbol-like if needed
      return result.filter((s): s is vscode.DocumentSymbol => "children" in s);
    } catch {
      return [];
    }
  }

  private processSymbols(
    rawSymbols: vscode.DocumentSymbol[],
    filePath: string,
    doc: vscode.TextDocument,
  ): CodeSymbol[] {
    const result: CodeSymbol[] = [];

    for (const sym of rawSymbols) {
      const kind = SYMBOL_KIND_MAP[sym.kind] || "unknown";

      // Check if the symbol is exported by examining the source line
      const line = doc.lineAt(sym.range.start.line).text;
      const exported = this.isExportedSymbol(line, doc.languageId);

      // Extract detail (e.g., return type, extends clause)
      const detail = sym.detail || this.extractDetail(line, kind);

      // Process children (methods, properties)
      const children = (sym.children || []).map((child) => ({
        name: child.name,
        kind: SYMBOL_KIND_MAP[child.kind] || "unknown",
        detail: child.detail || "",
      }));

      result.push({
        name: sym.name,
        kind,
        file: filePath,
        line: sym.range.start.line + 1,
        exported,
        detail,
        children,
      });
    }

    return result;
  }

  private isExportedSymbol(line: string, languageId: string): boolean {
    const trimmed = line.trim();

    // TypeScript / JavaScript
    if (
      languageId.includes("typescript") ||
      languageId.includes("javascript")
    ) {
      return (
        trimmed.startsWith("export ") ||
        trimmed.startsWith("export default ") ||
        trimmed.startsWith("module.exports")
      );
    }

    // Python — top-level definitions without underscore are public
    if (languageId === "python") {
      const match = trimmed.match(/^(?:def|class)\s+(\w+)/);
      return !!match && !match[1].startsWith("_");
    }

    // Go — uppercase first letter means exported
    if (languageId === "go") {
      const match = trimmed.match(/^(?:func|type|var|const)\s+(\w)/);
      return !!match && match[1] === match[1].toUpperCase();
    }

    // Rust — pub keyword
    if (languageId === "rust") {
      return trimmed.startsWith("pub ");
    }

    // Java / C# — public keyword
    if (languageId === "java" || languageId === "csharp") {
      return trimmed.startsWith("public ");
    }

    return false;
  }

  private extractDetail(line: string, kind: string): string {
    const trimmed = line.trim();

    if (kind === "class") {
      const extendsMatch = trimmed.match(/extends\s+([\w.]+)/);
      const implMatch = trimmed.match(/implements\s+([\w.,\s]+)/);
      const parts: string[] = [];
      if (extendsMatch) parts.push(`extends ${extendsMatch[1]}`);
      if (implMatch) parts.push(`implements ${implMatch[1].trim()}`);
      return parts.join(" ");
    }

    if (kind === "function") {
      // Extract return type for TypeScript
      const returnMatch = trimmed.match(/\):\s*([\w<>[\]|&\s]+)\s*[{;]/);
      return returnMatch ? `→ ${returnMatch[1].trim()}` : "";
    }

    if (kind === "interface") {
      const extendsMatch = trimmed.match(/extends\s+([\w.,\s]+)/);
      return extendsMatch ? `extends ${extendsMatch[1].trim()}` : "";
    }

    return "";
  }

  // ─── Import Extraction ──────────────────────────────────────────────

  private extractImports(
    doc: vscode.TextDocument,
    filePath: string,
    rootPath: string,
  ): ImportEdge[] {
    const text = doc.getText();
    const langId = doc.languageId;
    const edges: ImportEdge[] = [];

    if (langId.includes("typescript") || langId.includes("javascript")) {
      edges.push(...this.extractJSImports(text, filePath, rootPath));
    } else if (langId === "python") {
      edges.push(...this.extractPythonImports(text, filePath));
    } else if (langId === "go") {
      edges.push(...this.extractGoImports(text, filePath));
    }

    return edges;
  }

  private extractJSImports(
    text: string,
    filePath: string,
    rootPath: string,
  ): ImportEdge[] {
    const edges: ImportEdge[] = [];

    // ES imports: import { X, Y } from 'module'
    const esImportRegex =
      /import\s+(?:(?:\{([^}]*)\}|(\w+))\s+from\s+)?['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;

    while ((match = esImportRegex.exec(text))) {
      const namedImports = match[1]
        ? match[1]
            .split(",")
            .map((s) =>
              s
                .trim()
                .split(/\s+as\s+/)[0]
                .trim(),
            )
            .filter(Boolean)
        : [];
      const defaultImport = match[2] ? [match[2]] : [];
      const modulePath = match[3];

      const symbols = [...defaultImport, ...namedImports];
      const isRelative =
        modulePath.startsWith(".") || modulePath.startsWith("/");

      let resolvedTo = modulePath;
      if (isRelative) {
        // Resolve to workspace-relative path
        const dir = path.dirname(filePath);
        resolvedTo = path.posix.normalize(path.posix.join(dir, modulePath));
        // Try common extensions
        if (!resolvedTo.match(/\.\w+$/)) {
          resolvedTo += ".ts"; // best guess
        }
      }

      edges.push({
        from: filePath,
        to: resolvedTo,
        symbols,
        isExternal: !isRelative,
      });
    }

    // CommonJS: const X = require('module')
    const requireRegex =
      /(?:const|let|var)\s+(?:\{([^}]*)\}|(\w+))\s*=\s*require\(['"]([^'"]+)['"]\)/g;
    while ((match = requireRegex.exec(text))) {
      const namedImports = match[1]
        ? match[1]
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const defaultImport = match[2] ? [match[2]] : [];
      const modulePath = match[3];
      const isRelative = modulePath.startsWith(".");

      edges.push({
        from: filePath,
        to: modulePath,
        symbols: [...defaultImport, ...namedImports],
        isExternal: !isRelative,
      });
    }

    return edges;
  }

  private extractPythonImports(text: string, filePath: string): ImportEdge[] {
    const edges: ImportEdge[] = [];

    // from module import X, Y
    const fromImportRegex = /^from\s+([\w.]+)\s+import\s+(.+)/gm;
    let match: RegExpExecArray | null;

    while ((match = fromImportRegex.exec(text))) {
      const module = match[1];
      const symbols = match[2]
        .split(",")
        .map((s) =>
          s
            .trim()
            .split(/\s+as\s+/)[0]
            .trim(),
        )
        .filter(Boolean);
      const isRelative = module.startsWith(".");

      edges.push({
        from: filePath,
        to: module,
        symbols,
        isExternal: !isRelative,
      });
    }

    // import module
    const importRegex = /^import\s+([\w.]+)(?:\s+as\s+\w+)?$/gm;
    while ((match = importRegex.exec(text))) {
      edges.push({
        from: filePath,
        to: match[1],
        symbols: [match[1].split(".").pop() || match[1]],
        isExternal: !match[1].startsWith("."),
      });
    }

    return edges;
  }

  private extractGoImports(text: string, filePath: string): ImportEdge[] {
    const edges: ImportEdge[] = [];

    // Single import
    const singleRegex = /^import\s+"([^"]+)"/gm;
    let match: RegExpExecArray | null;
    while ((match = singleRegex.exec(text))) {
      edges.push({
        from: filePath,
        to: match[1],
        symbols: [match[1].split("/").pop() || match[1]],
        isExternal: true,
      });
    }

    // Block import
    const blockMatch = text.match(/import\s*\(([\s\S]*?)\)/);
    if (blockMatch) {
      const lines = blockMatch[1].split("\n");
      for (const line of lines) {
        const pathMatch = line.match(/"([^"]+)"/);
        if (pathMatch) {
          edges.push({
            from: filePath,
            to: pathMatch[1],
            symbols: [pathMatch[1].split("/").pop() || pathMatch[1]],
            isExternal: true,
          });
        }
      }
    }

    return edges;
  }

  // ─── API Endpoint Detection ─────────────────────────────────────────

  private async detectAPIEndpoints(
    modules: ModuleSummary[],
  ): Promise<APIEndpoint[]> {
    const endpoints: APIEndpoint[] = [];

    for (const mod of modules) {
      try {
        const uri = vscode.Uri.joinPath(this.workspaceFolder.uri, mod.file);
        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();

        // Express/Fastify-style routes: app.get('/path', handler)
        const routeRegex =
          /(?:app|router|server)\.(get|post|put|delete|patch|options|head)\s*\(\s*['"]([^'"]+)['"]/gi;
        let match: RegExpExecArray | null;
        while ((match = routeRegex.exec(text))) {
          const line = doc.positionAt(match.index).line + 1;
          endpoints.push({
            method: match[1].toUpperCase(),
            path: match[2],
            file: mod.file,
            line,
            handler: `${match[1].toLowerCase()}('${match[2]}')`,
          });
        }

        // Next.js App Router: export async function GET/POST/PUT/DELETE
        const nextRouteRegex =
          /export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*\(/g;
        while ((match = nextRouteRegex.exec(text))) {
          const line = doc.positionAt(match.index).line + 1;
          // Derive route from file path (app/api/users/route.ts → /api/users)
          const routePath = this.deriveNextJSRoute(mod.file);
          endpoints.push({
            method: match[1],
            path: routePath,
            file: mod.file,
            line,
            handler: `export function ${match[1]}()`,
          });
        }

        // Python Flask/FastAPI: @app.route('/path') or @app.get('/path')
        const pyRouteRegex =
          /@(?:app|router)\.(route|get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g;
        while ((match = pyRouteRegex.exec(text))) {
          const line = doc.positionAt(match.index).line + 1;
          const method = match[1] === "route" ? "GET" : match[1].toUpperCase();
          endpoints.push({
            method,
            path: match[2],
            file: mod.file,
            line,
            handler: `@app.${match[1]}('${match[2]}')`,
          });
        }
      } catch {
        // File unreadable — skip
      }
    }

    return endpoints.sort((a, b) => a.path.localeCompare(b.path));
  }

  private deriveNextJSRoute(filePath: string): string {
    // app/api/users/route.ts → /api/users
    // app/api/users/[id]/route.ts → /api/users/[id]
    let route = filePath
      .replace(/^(?:src\/)?app/, "")
      .replace(/\/route\.\w+$/, "")
      .replace(/\/page\.\w+$/, "");
    if (!route.startsWith("/")) route = "/" + route;
    return route || "/";
  }

  // ─── Report Formatting ──────────────────────────────────────────────

  /**
   * Generate a human + RAG-friendly markdown report from the analysis.
   */
  formatReport(report: CodeIntelligenceReport): string {
    const sections: string[] = [];

    // Module summary
    sections.push(`## Module Analysis (${report.modules.length} files)\n`);

    for (const mod of report.modules) {
      if (mod.symbols.length === 0) continue;

      sections.push(`### \`${mod.file}\` (${mod.lineCount} lines)\n`);

      // Exports
      if (mod.exports.length > 0) {
        sections.push(
          `**Exports**: ${mod.exports.map((e) => `\`${e}\``).join(", ")}\n`,
        );
      }

      // Key symbols
      const keySymbols = mod.symbols.filter((s) =>
        ["class", "function", "interface", "enum"].includes(s.kind),
      );
      if (keySymbols.length > 0) {
        for (const sym of keySymbols) {
          const expLabel = sym.exported ? "📤" : "🔒";
          const detailLabel = sym.detail ? ` — ${sym.detail}` : "";
          sections.push(
            `- ${expLabel} \`${sym.kind}\` **${sym.name}**${detailLabel} (L${sym.line})`,
          );

          // Show class/interface members
          if (sym.children.length > 0 && sym.children.length <= 15) {
            for (const child of sym.children) {
              sections.push(`  - \`${child.kind}\` ${child.name}`);
            }
          } else if (sym.children.length > 15) {
            sections.push(
              `  - *(${sym.children.length} members — see source)*`,
            );
          }
        }
        sections.push("");
      }
    }

    // Internal dependency graph
    if (report.internalDependencyGraph.length > 0) {
      sections.push(`## Internal Dependency Graph\n`);
      sections.push(`| Importer | Imports From | Symbols |`, `|---|---|---|`);
      for (const edge of report.internalDependencyGraph.slice(0, 50)) {
        const syms =
          edge.symbols.length > 3
            ? edge.symbols.slice(0, 3).join(", ") + "..."
            : edge.symbols.join(", ");
        sections.push(`| \`${edge.from}\` | \`${edge.to}\` | ${syms} |`);
      }
      sections.push("");
    }

    // Public API
    if (report.publicAPI.length > 0) {
      sections.push(`## Public API (${report.publicAPI.length} exports)\n`);
      const grouped = new Map<string, CodeSymbol[]>();
      for (const sym of report.publicAPI) {
        const existing = grouped.get(sym.file) || [];
        existing.push(sym);
        grouped.set(sym.file, existing);
      }
      for (const [file, syms] of grouped) {
        sections.push(
          `**${file}**: ${syms.map((s) => `\`${s.name}\` (${s.kind})`).join(", ")}`,
        );
      }
      sections.push("");
    }

    // API Endpoints
    if (report.apiEndpoints.length > 0) {
      sections.push(`## API Endpoints\n`);
      sections.push(`| Method | Path | File | Line |`, `|---|---|---|---|`);
      for (const ep of report.apiEndpoints) {
        sections.push(
          `| **${ep.method}** | \`${ep.path}\` | \`${ep.file}\` | L${ep.line} |`,
        );
      }
      sections.push("");
    }

    // Complexity ranking
    if (report.complexityRanking.length > 0) {
      sections.push(`## Complexity Ranking\n`);
      sections.push(`| File | Symbols | Lines |`, `|---|---|---|`);
      for (const entry of report.complexityRanking.slice(0, 20)) {
        sections.push(
          `| \`${entry.file}\` | ${entry.symbolCount} | ${entry.lineCount} |`,
        );
      }
      sections.push("");
    }

    return sections.join("\n");
  }
}
