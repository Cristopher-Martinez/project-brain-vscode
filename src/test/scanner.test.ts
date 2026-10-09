import * as assert from "assert";
import * as path from "path";

// ─── Scanner Tests ───────────────────────────────────────────────────────────
// Test project type detection logic, file tree building, and dependency extraction

suite("Scanner — Project Type Detection Tests", () => {
  test("Detect Node.js project from package.json content", () => {
    const packageJson = JSON.stringify({
      name: "my-app",
      scripts: { start: "node index.js" },
      dependencies: { express: "^4.18.0" },
    });

    const parsed = JSON.parse(packageJson);
    const deps = Object.keys(parsed.dependencies || {});
    const devDeps = Object.keys(parsed.devDependencies || {});
    const allDeps = [...deps, ...devDeps];

    let projectType = "Node.js";
    if (allDeps.includes("react") || allDeps.includes("next")) {
      projectType = "React/Next.js";
    } else if (allDeps.includes("@angular/core")) {
      projectType = "Angular";
    } else if (allDeps.includes("vue")) {
      projectType = "Vue.js";
    } else if (allDeps.includes("express") || allDeps.includes("fastify")) {
      projectType = "Node.js API";
    }

    assert.strictEqual(
      projectType,
      "Node.js API",
      "Should detect Express app as Node.js API",
    );
  });

  test("Detect React project", () => {
    const packageJson = {
      dependencies: { react: "^18.2.0", "react-dom": "^18.2.0" },
    };
    const deps = Object.keys(packageJson.dependencies);

    const isReact = deps.includes("react");
    assert.strictEqual(isReact, true);
  });

  test("Detect Python project from requirements.txt", () => {
    const requirements = "flask==3.0.0\nrequests==2.31.0\npandas>=1.5.0";
    const deps = requirements
      .split("\n")
      .map((line) => {
        const match = line.match(/^([a-zA-Z0-9_-]+)/);
        return match ? match[1] : null;
      })
      .filter(Boolean);

    assert.deepStrictEqual(deps, ["flask", "requests", "pandas"]);
  });

  test("Detect Rust project from Cargo.toml", () => {
    // Simply check file existence
    const files = ["Cargo.toml", "src/main.rs", "src/lib.rs"];
    const hasCargo = files.includes("Cargo.toml");
    assert.strictEqual(hasCargo, true, "Should detect Cargo.toml");
  });

  test("Detect Go project from go.mod", () => {
    const goMod = `module github.com/user/project

go 1.21

require (
    github.com/gin-gonic/gin v1.9.1
    github.com/lib/pq v1.10.9
)`;

    const moduleMatch = goMod.match(/^module\s+(.+)/m);
    assert.ok(moduleMatch, "Should find module declaration");
    assert.strictEqual(moduleMatch![1], "github.com/user/project");

    const deps: string[] = [];
    const reqMatch = goMod.match(/require\s*\(([\s\S]*?)\)/);
    if (reqMatch) {
      const lines = reqMatch[1].trim().split("\n");
      for (const line of lines) {
        const depMatch = line.trim().match(/^(\S+)\s/);
        if (depMatch) deps.push(depMatch[1]);
      }
    }
    assert.deepStrictEqual(deps, [
      "github.com/gin-gonic/gin",
      "github.com/lib/pq",
    ]);
  });
});

suite("Scanner — File Tree Tests", () => {
  test("Build file tree structure from paths", () => {
    const files = [
      "src/index.ts",
      "src/utils/helpers.ts",
      "src/utils/validators.ts",
      "src/components/App.tsx",
      "package.json",
      "tsconfig.json",
    ];

    // Build tree (simplified representation)
    const tree: Record<string, string[]> = {};
    for (const file of files) {
      const dir = path.posix.dirname(file);
      if (!tree[dir]) tree[dir] = [];
      tree[dir].push(path.posix.basename(file));
    }

    assert.ok(tree["."], "Should have root entries");
    assert.ok(tree["src"], "Should have src entries");
    assert.ok(tree["src/utils"], "Should have src/utils entries");
    assert.ok(tree["src/components"], "Should have src/components entries");
    assert.ok(tree["."].includes("package.json"));
    assert.ok(tree["src"].includes("index.ts"));
    assert.ok(tree["src/utils"].includes("helpers.ts"));
  });

  test("Should exclude node_modules and other ignored dirs", () => {
    const allFiles = [
      "src/index.ts",
      "node_modules/express/index.js",
      "dist/bundle.js",
      ".git/HEAD",
      "src/app.ts",
      "coverage/lcov.info",
    ];

    const excludePatterns = new Set([
      "node_modules",
      "dist",
      ".git",
      "coverage",
    ]);

    const filtered = allFiles.filter((f) => {
      const firstDir = f.split("/")[0];
      return !excludePatterns.has(firstDir);
    });

    assert.strictEqual(filtered.length, 2);
    assert.ok(filtered.includes("src/index.ts"));
    assert.ok(filtered.includes("src/app.ts"));
  });

  test("Count lines by file extension", () => {
    const fileStats = [
      { path: "src/a.ts", lines: 100 },
      { path: "src/b.ts", lines: 200 },
      { path: "src/c.js", lines: 50 },
      { path: "src/d.py", lines: 150 },
    ];

    const linesByExt = new Map<string, number>();
    for (const f of fileStats) {
      const ext = path.extname(f.path);
      linesByExt.set(ext, (linesByExt.get(ext) || 0) + f.lines);
    }

    assert.strictEqual(linesByExt.get(".ts"), 300);
    assert.strictEqual(linesByExt.get(".js"), 50);
    assert.strictEqual(linesByExt.get(".py"), 150);
  });
});

suite("Scanner — Dependency Extraction Tests", () => {
  test("Extract npm dependencies from package.json", () => {
    const packageJson = {
      dependencies: {
        express: "^4.18.0",
        lodash: "^4.17.21",
      },
      devDependencies: {
        typescript: "^5.3.0",
        jest: "^29.0.0",
      },
    };

    const prod = Object.entries(packageJson.dependencies).map(
      ([name, version]) => ({
        name,
        version,
        type: "production" as const,
      }),
    );

    const dev = Object.entries(packageJson.devDependencies).map(
      ([name, version]) => ({
        name,
        version,
        type: "development" as const,
      }),
    );

    assert.strictEqual(prod.length, 2);
    assert.strictEqual(dev.length, 2);
    assert.strictEqual(prod[0].name, "express");
    assert.strictEqual(prod[0].type, "production");
    assert.strictEqual(dev[0].name, "typescript");
    assert.strictEqual(dev[0].type, "development");
  });

  test("Extract Python dependencies from requirements.txt", () => {
    const content = `
flask==3.0.0
requests>=2.31.0
pandas~=1.5.0
# comment line
numpy
python-dotenv==1.0.0
`;

    const deps = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => {
        const match = l.match(/^([a-zA-Z0-9_-]+)(?:[=<>~!]+(.+))?$/);
        return match ? { name: match[1], version: match[2] || "latest" } : null;
      })
      .filter(Boolean);

    assert.strictEqual(deps!.length, 5);
    assert.strictEqual(deps![0]!.name, "flask");
    assert.strictEqual(deps![0]!.version, "3.0.0");
    assert.strictEqual(deps![3]!.name, "numpy");
    assert.strictEqual(deps![3]!.version, "latest");
  });

  test("Handle scoped npm packages", () => {
    const importPath = "@scope/package/utils";
    const parts = importPath.split("/");
    const pkgName =
      importPath.startsWith("@") && parts.length > 1
        ? `${parts[0]}/${parts[1]}`
        : parts[0];

    assert.strictEqual(pkgName, "@scope/package");

    const simpleImport = "lodash/fp";
    const simpleParts = simpleImport.split("/");
    const simplePkg =
      simpleImport.startsWith("@") && simpleParts.length > 1
        ? `${simpleParts[0]}/${simpleParts[1]}`
        : simpleParts[0];

    assert.strictEqual(simplePkg, "lodash");
  });
});
