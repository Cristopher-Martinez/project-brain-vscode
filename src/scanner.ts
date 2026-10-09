import { glob } from "glob";
import * as path from "path";
import * as vscode from "vscode";
import { ProjectDocs } from "./bootstrapper";
import { CodeIntelligenceAnalyzer } from "./code-intelligence";
import { GitAnalyzer } from "./git-analyzer";
import { PatternDetector } from "./pattern-detector";
import { ScanCacheManager } from "./scan-cache";
import { log, logError, logWarn } from "./logger";

export class ProjectScanner {
  private cacheManager: ScanCacheManager;

  constructor(private workspaceFolder: vscode.WorkspaceFolder) {
    this.cacheManager = new ScanCacheManager(workspaceFolder);
  }

  async scanProject(options?: { incremental?: boolean }): Promise<ProjectDocs> {
    const rootPath = this.workspaceFolder.uri.fsPath;
    const incremental = options?.incremental ?? true;

    // Load scan cache for incremental mode
    let isIncremental = false;
    if (incremental) {
      const cache = await this.cacheManager.load();
      if (cache) {
        isIncremental = true;
        log("Using incremental scan (cache found)");
      } else {
        this.cacheManager.init();
        log("Full scan (no cache)");
      }
    } else {
      this.cacheManager.init();
    }

    // Detect project type
    const projectType = await this.detectProjectType(rootPath);

    // Parallel: basic scan + git analysis + pattern detection + code intelligence
    const config = vscode.workspace.getConfiguration("projectBrain");
    const analyzeGit = config.get<boolean>("analyzeGitHistory", true);

    const gitAnalyzer = new GitAnalyzer(rootPath);
    const patternDetector = new PatternDetector(this.workspaceFolder);
    const codeIntel = new CodeIntelligenceAnalyzer(this.workspaceFolder);

    const [
      overview,
      architecture,
      codeMap,
      dependencies,
      gitInsights,
      patterns,
      codeIntelligence,
    ] = await Promise.all([
      this.generateOverview(rootPath, projectType),
      this.generateArchitecture(rootPath, projectType),
      this.generateCodeMap(rootPath, projectType),
      this.extractDependencies(rootPath, projectType),
      analyzeGit ? gitAnalyzer.analyze() : Promise.resolve(undefined),
      patternDetector.detect(),
      codeIntel.analyze().catch(() => undefined),
    ]);

    // Save cache after scan
    this.cacheManager.markFullScan();
    await this.cacheManager.save();

    return {
      overview,
      architecture,
      codeMap,
      dependencies,
      projectType,
      gitInsights,
      patterns,
      codeIntelligence,
    };
  }

  /** Get cache stats (for status display) */
  getCacheStats() {
    return this.cacheManager.getStats();
  }

  private async detectProjectType(rootPath: string): Promise<string> {
    const packageJsonPath = vscode.Uri.file(
      path.join(rootPath, "package.json"),
    );
    const requirementsPath = vscode.Uri.file(
      path.join(rootPath, "requirements.txt"),
    );
    const cargoPath = vscode.Uri.file(path.join(rootPath, "Cargo.toml"));
    const goModPath = vscode.Uri.file(path.join(rootPath, "go.mod"));

    try {
      await vscode.workspace.fs.stat(packageJsonPath);
      const content = await vscode.workspace.fs.readFile(packageJsonPath);
      const pkg = JSON.parse(content.toString());

      if (pkg.dependencies?.react || pkg.devDependencies?.react) {
        return "React";
      }
      if (pkg.dependencies?.next || pkg.devDependencies?.next) {
        return "Next.js";
      }
      if (pkg.dependencies?.vue || pkg.devDependencies?.vue) {
        return "Vue.js";
      }
      if (pkg.dependencies?.express) {
        return "Node.js/Express";
      }
      return "Node.js";
    } catch {
      // File not found, continue
    }

    try {
      await vscode.workspace.fs.stat(requirementsPath);
      return "Python";
    } catch {
      // File not found, continue
    }

    try {
      await vscode.workspace.fs.stat(cargoPath);
      return "Rust";
    } catch {
      // File not found, continue
    }

    try {
      await vscode.workspace.fs.stat(goModPath);
      return "Go";
    } catch {
      // File not found, continue
    }

    return "Unknown";
  }

  private async generateOverview(
    rootPath: string,
    projectType: string,
  ): Promise<string> {
    const readmePath = vscode.Uri.file(path.join(rootPath, "README.md"));

    try {
      const content = await vscode.workspace.fs.readFile(readmePath);
      return content.toString();
    } catch {
      return `# ${path.basename(rootPath)}\n\nProject type: ${projectType}\n\nNo README.md found. Add a description here.`;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async generateArchitecture(
    rootPath: string,
    _projectType: string,
  ): Promise<string> {
    const srcDirs = ["src", "lib", "app", "components", "pages"];
    const foundDirs: string[] = [];

    for (const dir of srcDirs) {
      const dirPath = vscode.Uri.file(path.join(rootPath, dir));
      try {
        const stat = await vscode.workspace.fs.stat(dirPath);
        if (stat.type === vscode.FileType.Directory) {
          foundDirs.push(dir);
        }
      } catch {
        // Directory not found, continue
      }
    }

    return `Main directories:\n${foundDirs.map((d) => `- ${d}/`).join("\n")}`;
  }

  private async generateCodeMap(
    rootPath: string,
    projectType: string,
  ): Promise<string> {
    const patterns: Record<string, string[]> = {
      "Node.js": ["**/*.ts", "**/*.js"],
      React: ["**/*.tsx", "**/*.jsx"],
      "Next.js": ["**/*.tsx", "**/*.jsx"],
      Python: ["**/*.py"],
      Rust: ["**/*.rs"],
      Go: ["**/*.go"],
    };

    const filePattern = patterns[projectType] || ["**/*"];
    const files = await glob(filePattern, {
      cwd: rootPath,
      ignore: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.git/**"],
      nodir: true,
    });

    const fileTree = this.buildFileTree(files.slice(0, 50)); // Limit to 50 files

    return fileTree;
  }

  private buildFileTree(files: string[]): string {
    const tree: Record<string, string[]> = {};

    for (const file of files) {
      const dir = path.dirname(file);
      if (!tree[dir]) {
        tree[dir] = [];
      }
      tree[dir].push(path.basename(file));
    }

    let output = "";
    for (const [dir, files] of Object.entries(tree)) {
      output += `\n## ${dir}/\n`;
      for (const file of files) {
        output += `- ${file}\n`;
      }
    }

    return output;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async extractDependencies(
    rootPath: string,
    _projectType: string,
  ): Promise<string[]> {
    const packageJsonPath = vscode.Uri.file(
      path.join(rootPath, "package.json"),
    );
    const requirementsPath = vscode.Uri.file(
      path.join(rootPath, "requirements.txt"),
    );

    try {
      const content = await vscode.workspace.fs.readFile(packageJsonPath);
      const pkg = JSON.parse(content.toString());
      const deps = [
        ...Object.keys(pkg.dependencies || {}),
        ...Object.keys(pkg.devDependencies || {}),
      ];
      return deps;
    } catch {
      // File not found or parse error, continue
    }

    try {
      const content = await vscode.workspace.fs.readFile(requirementsPath);
      const deps = content
        .toString()
        .split("\n")
        .filter((line) => line.trim() && !line.startsWith("#"))
        .map((line) => line.split("==")[0].trim());
      return deps;
    } catch {
      // File not found or parse error, continue
    }

    return [];
  }
}
