import * as path from "path";
import * as vscode from "vscode";

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface EntryPoint {
  file: string;
  type: "main" | "build" | "test" | "config" | "script" | "serve";
  description: string;
}

export interface DetectedPattern {
  name: string;
  evidence: string;
  files: string[];
}

export interface LayerInfo {
  name: string;
  directories: string[];
  files: string[];
}

export interface DetectedPatterns {
  entryPoints: EntryPoint[];
  patterns: DetectedPattern[];
  layers: LayerInfo[];
  /** Key config files found (tsconfig, eslint, docker, etc.) */
  configFiles: string[];
  /** Detected testing frameworks and locations */
  testingInfo: { framework: string; directories: string[] } | null;
}

// ─── Detectors ───────────────────────────────────────────────────────────────

const CONFIG_FILES = [
  // Build / Tooling
  "tsconfig.json",
  "tsconfig.build.json",
  "tsconfig.base.json",
  "webpack.config.js",
  "webpack.config.ts",
  "vite.config.ts",
  "vite.config.js",
  "rollup.config.js",
  "esbuild.config.js",
  "turbo.json",
  "nx.json",
  // Linting / Formatting
  ".eslintrc.js",
  ".eslintrc.json",
  ".eslintrc.yml",
  "eslint.config.js",
  "eslint.config.mjs",
  ".prettierrc",
  ".prettierrc.json",
  "biome.json",
  // Containerization
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".dockerignore",
  // CI/CD
  ".github/workflows",
  ".gitlab-ci.yml",
  "Jenkinsfile",
  // Package management
  "package.json",
  "pnpm-workspace.yaml",
  "lerna.json",
  "requirements.txt",
  "Pipfile",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "Gemfile",
  "composer.json",
  // ORM / DB
  "prisma/schema.prisma",
  "drizzle.config.ts",
  "knexfile.js",
  // Environment
  ".env.example",
  ".env.local",
  // API
  "openapi.yaml",
  "openapi.json",
  "swagger.json",
  // Other
  "Makefile",
  "justfile",
  "tailwind.config.js",
  "tailwind.config.ts",
  "next.config.js",
  "next.config.mjs",
  "nuxt.config.ts",
  "astro.config.mjs",
];

export class PatternDetector {
  constructor(private workspaceFolder: vscode.WorkspaceFolder) {}

  async detect(): Promise<DetectedPatterns> {
    const rootPath = this.workspaceFolder.uri.fsPath;

    const [configFiles, entryPoints, layers, testingInfo] = await Promise.all([
      this.findConfigFiles(rootPath),
      this.detectEntryPoints(rootPath),
      this.detectLayers(rootPath),
      this.detectTestingFramework(rootPath),
    ]);

    const patterns = await this.detectArchitecturalPatterns(
      rootPath,
      configFiles,
      layers,
    );

    return {
      entryPoints,
      patterns,
      layers,
      configFiles,
      testingInfo,
    };
  }

  // ─── Config files ─────────────────────────────────────────────────

  private async findConfigFiles(rootPath: string): Promise<string[]> {
    const found: string[] = [];

    for (const file of CONFIG_FILES) {
      const uri = vscode.Uri.file(path.join(rootPath, file));
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (
          stat.type === vscode.FileType.File ||
          stat.type === vscode.FileType.Directory
        ) {
          found.push(file);
        }
      } catch {
        // Not found — continue
      }
    }

    return found;
  }

  // ─── Entry points ────────────────────────────────────────────────

  private async detectEntryPoints(rootPath: string): Promise<EntryPoint[]> {
    const entries: EntryPoint[] = [];

    // Check package.json scripts
    try {
      const pkgUri = vscode.Uri.file(path.join(rootPath, "package.json"));
      const raw = await vscode.workspace.fs.readFile(pkgUri);
      const pkg = JSON.parse(Buffer.from(raw).toString("utf-8"));

      if (pkg.main) {
        entries.push({
          file: pkg.main,
          type: "main",
          description: `Package main entry: ${pkg.main}`,
        });
      }

      if (pkg.scripts) {
        const scriptMap: Record<string, EntryPoint["type"]> = {
          start: "serve",
          dev: "serve",
          serve: "serve",
          build: "build",
          test: "test",
          "test:unit": "test",
          "test:e2e": "test",
          lint: "config",
        };

        for (const [name, type] of Object.entries(scriptMap)) {
          if (pkg.scripts[name]) {
            entries.push({
              file: `npm run ${name}`,
              type,
              description: `script: ${pkg.scripts[name]}`,
            });
          }
        }
      }
    } catch {
      // No package.json — skip
    }

    // Common entry file patterns
    const commonEntries: {
      glob: string;
      type: EntryPoint["type"];
      desc: string;
    }[] = [
      { glob: "src/index.ts", type: "main", desc: "TypeScript entry" },
      { glob: "src/index.js", type: "main", desc: "JavaScript entry" },
      { glob: "src/main.ts", type: "main", desc: "TypeScript main" },
      { glob: "src/main.js", type: "main", desc: "JavaScript main" },
      { glob: "src/app.ts", type: "main", desc: "App entry" },
      { glob: "src/app.js", type: "main", desc: "App entry" },
      { glob: "src/server.ts", type: "serve", desc: "Server entry" },
      { glob: "src/server.js", type: "serve", desc: "Server entry" },
      { glob: "app/layout.tsx", type: "main", desc: "Next.js root layout" },
      { glob: "pages/_app.tsx", type: "main", desc: "Next.js pages app" },
      {
        glob: "src/extension.ts",
        type: "main",
        desc: "VS Code extension entry",
      },
      { glob: "manage.py", type: "script", desc: "Django management" },
      { glob: "main.py", type: "main", desc: "Python main" },
      { glob: "src/main.rs", type: "main", desc: "Rust main" },
      { glob: "cmd/main.go", type: "main", desc: "Go main" },
      { glob: "main.go", type: "main", desc: "Go main" },
    ];

    for (const entry of commonEntries) {
      const uri = vscode.Uri.file(path.join(rootPath, entry.glob));
      try {
        await vscode.workspace.fs.stat(uri);
        entries.push({
          file: entry.glob,
          type: entry.type,
          description: entry.desc,
        });
      } catch {
        // Not found
      }
    }

    return entries;
  }

  // ─── Layers / Modules ────────────────────────────────────────────

  private async detectLayers(rootPath: string): Promise<LayerInfo[]> {
    const layerPatterns: { name: string; dirs: string[] }[] = [
      {
        name: "API / Routes",
        dirs: [
          "src/routes",
          "src/api",
          "src/controllers",
          "app/api",
          "pages/api",
        ],
      },
      {
        name: "Business Logic",
        dirs: [
          "src/services",
          "src/domain",
          "src/core",
          "src/logic",
          "src/use-cases",
        ],
      },
      {
        name: "Data / Models",
        dirs: [
          "src/models",
          "src/entities",
          "src/schemas",
          "src/db",
          "prisma",
          "src/repositories",
        ],
      },
      {
        name: "UI / Components",
        dirs: ["src/components", "src/views", "src/pages", "app", "components"],
      },
      {
        name: "Shared / Utils",
        dirs: [
          "src/utils",
          "src/helpers",
          "src/lib",
          "src/shared",
          "src/common",
        ],
      },
      { name: "Configuration", dirs: ["src/config", "config", "src/settings"] },
      { name: "Middleware", dirs: ["src/middleware", "src/middlewares"] },
      {
        name: "Types / Interfaces",
        dirs: ["src/types", "src/interfaces", "src/@types"],
      },
      {
        name: "Tests",
        dirs: ["tests", "test", "src/__tests__", "__tests__", "spec"],
      },
      { name: "Scripts / Tools", dirs: ["scripts", "tools", "bin"] },
    ];

    const layers: LayerInfo[] = [];

    for (const pattern of layerPatterns) {
      const foundDirs: string[] = [];
      const foundFiles: string[] = [];

      for (const dir of pattern.dirs) {
        const dirUri = vscode.Uri.file(path.join(rootPath, dir));
        try {
          const stat = await vscode.workspace.fs.stat(dirUri);
          if (stat.type === vscode.FileType.Directory) {
            foundDirs.push(dir);

            // List top-level files in the directory
            const entries = await vscode.workspace.fs.readDirectory(dirUri);
            const files = entries
              .filter(([, type]) => type === vscode.FileType.File)
              .map(([name]) => path.join(dir, name))
              .slice(0, 10); // limit per dir
            foundFiles.push(...files);
          }
        } catch {
          // Not found
        }
      }

      if (foundDirs.length > 0) {
        layers.push({
          name: pattern.name,
          directories: foundDirs,
          files: foundFiles,
        });
      }
    }

    return layers;
  }

  // ─── Testing ──────────────────────────────────────────────────────

  private async detectTestingFramework(
    rootPath: string,
  ): Promise<{ framework: string; directories: string[] } | null> {
    try {
      const pkgUri = vscode.Uri.file(path.join(rootPath, "package.json"));
      const raw = await vscode.workspace.fs.readFile(pkgUri);
      const pkg = JSON.parse(Buffer.from(raw).toString("utf-8"));

      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };

      const frameworks: { name: string; packages: string[] }[] = [
        { name: "Vitest", packages: ["vitest"] },
        { name: "Jest", packages: ["jest", "ts-jest", "@jest/core"] },
        { name: "Mocha", packages: ["mocha"] },
        { name: "Playwright", packages: ["@playwright/test", "playwright"] },
        { name: "Cypress", packages: ["cypress"] },
        { name: "Ava", packages: ["ava"] },
      ];

      for (const fw of frameworks) {
        const found = fw.packages.some((p) => p in allDeps);
        if (found) {
          // Find test directories
          const testDirs: string[] = [];
          for (const dir of [
            "tests",
            "test",
            "src/__tests__",
            "__tests__",
            "e2e",
            "spec",
          ]) {
            const dirUri = vscode.Uri.file(path.join(rootPath, dir));
            try {
              await vscode.workspace.fs.stat(dirUri);
              testDirs.push(dir);
            } catch {
              // not found
            }
          }
          return { framework: fw.name, directories: testDirs };
        }
      }
    } catch {
      // No package.json
    }

    // Python testing
    try {
      const pyprojectUri = vscode.Uri.file(
        path.join(rootPath, "pyproject.toml"),
      );
      await vscode.workspace.fs.stat(pyprojectUri);
      return { framework: "pytest (likely)", directories: ["tests"] };
    } catch {
      // not found
    }

    return null;
  }

  // ─── Architectural patterns ───────────────────────────────────────

  private async detectArchitecturalPatterns(
    rootPath: string,
    configFiles: string[],
    layers: LayerInfo[],
  ): Promise<DetectedPattern[]> {
    const patterns: DetectedPattern[] = [];
    const layerNames = new Set(layers.map((l) => l.name));

    // Monorepo detection
    if (
      configFiles.includes("pnpm-workspace.yaml") ||
      configFiles.includes("lerna.json") ||
      configFiles.includes("turbo.json") ||
      configFiles.includes("nx.json")
    ) {
      patterns.push({
        name: "Monorepo",
        evidence: "Workspace config file detected",
        files: configFiles.filter((f) =>
          [
            "pnpm-workspace.yaml",
            "lerna.json",
            "turbo.json",
            "nx.json",
          ].includes(f),
        ),
      });
    }

    // MVC / Layered architecture
    const hasApi = layerNames.has("API / Routes");
    const hasServices = layerNames.has("Business Logic");
    const hasModels = layerNames.has("Data / Models");
    if (hasApi && hasServices && hasModels) {
      patterns.push({
        name: "Layered / MVC Architecture",
        evidence: "Routes, services, and models layers detected",
        files: layers
          .filter((l) =>
            ["API / Routes", "Business Logic", "Data / Models"].includes(
              l.name,
            ),
          )
          .flatMap((l) => l.directories),
      });
    } else if (hasApi && hasModels) {
      patterns.push({
        name: "MVC (Model-View-Controller)",
        evidence: "Routes and models layers detected",
        files: layers
          .filter((l) => ["API / Routes", "Data / Models"].includes(l.name))
          .flatMap((l) => l.directories),
      });
    }

    // Component-based UI
    if (layerNames.has("UI / Components")) {
      patterns.push({
        name: "Component-Based Architecture",
        evidence: "UI components directory detected",
        files:
          layers.find((l) => l.name === "UI / Components")?.directories || [],
      });
    }

    // Containerized
    if (
      configFiles.includes("Dockerfile") ||
      configFiles.includes("docker-compose.yml") ||
      configFiles.includes("docker-compose.yaml")
    ) {
      patterns.push({
        name: "Containerized Deployment",
        evidence: "Docker configuration found",
        files: configFiles.filter(
          (f) => f.startsWith("Dockerfile") || f.startsWith("docker-compose"),
        ),
      });
    }

    // CI/CD
    if (
      configFiles.includes(".github/workflows") ||
      configFiles.includes(".gitlab-ci.yml") ||
      configFiles.includes("Jenkinsfile")
    ) {
      patterns.push({
        name: "CI/CD Pipeline",
        evidence: "CI/CD configuration detected",
        files: configFiles.filter((f) =>
          [".github/workflows", ".gitlab-ci.yml", "Jenkinsfile"].includes(f),
        ),
      });
    }

    // ORM
    if (configFiles.includes("prisma/schema.prisma")) {
      patterns.push({
        name: "Prisma ORM",
        evidence: "Prisma schema file detected",
        files: ["prisma/schema.prisma"],
      });
    }
    if (configFiles.includes("drizzle.config.ts")) {
      patterns.push({
        name: "Drizzle ORM",
        evidence: "Drizzle config found",
        files: ["drizzle.config.ts"],
      });
    }

    // Next.js App Router vs Pages Router
    const appDirUri = vscode.Uri.file(path.join(rootPath, "app"));
    const pagesDirUri = vscode.Uri.file(path.join(rootPath, "pages"));
    try {
      await vscode.workspace.fs.stat(appDirUri);
      if (configFiles.some((f) => f.startsWith("next.config"))) {
        patterns.push({
          name: "Next.js App Router",
          evidence: "app/ directory with next.config found",
          files: ["app/"],
        });
      }
    } catch {
      try {
        await vscode.workspace.fs.stat(pagesDirUri);
        if (configFiles.some((f) => f.startsWith("next.config"))) {
          patterns.push({
            name: "Next.js Pages Router",
            evidence: "pages/ directory with next.config found",
            files: ["pages/"],
          });
        }
      } catch {
        // Neither
      }
    }

    // Tailwind CSS
    if (configFiles.some((f) => f.startsWith("tailwind.config"))) {
      patterns.push({
        name: "Tailwind CSS",
        evidence: "Tailwind config found",
        files: configFiles.filter((f) => f.startsWith("tailwind.config")),
      });
    }

    return patterns;
  }
}
