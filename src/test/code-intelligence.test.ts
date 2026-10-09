import * as assert from "assert";

// ─── Code Intelligence Tests ─────────────────────────────────────────────────
// Test import extraction regex logic (pure functions, no VS Code dependency)

suite("Code Intelligence — Import Extraction Tests", () => {
  // ─── JavaScript/TypeScript Imports ────────────────────────────────

  test("Extract ES imports - named imports", () => {
    const text = `import { foo, bar } from './utils';\nimport { baz } from 'lodash';`;
    const regex =
      /import\s+(?:(?:\{([^}]*)\}|(\w+))\s+from\s+)?['"]([^'"]+)['"]/g;

    const results: Array<{
      symbols: string[];
      module: string;
      isExternal: boolean;
    }> = [];
    let match;
    while ((match = regex.exec(text))) {
      const named = match[1] ? match[1].split(",").map((s) => s.trim()) : [];
      const def = match[2] ? [match[2]] : [];
      const mod = match[3];
      results.push({
        symbols: [...def, ...named],
        module: mod,
        isExternal: !mod.startsWith("."),
      });
    }

    assert.strictEqual(results.length, 2, "Should find 2 imports");
    assert.deepStrictEqual(results[0].symbols, ["foo", "bar"]);
    assert.strictEqual(results[0].module, "./utils");
    assert.strictEqual(results[0].isExternal, false);
    assert.deepStrictEqual(results[1].symbols, ["baz"]);
    assert.strictEqual(results[1].module, "lodash");
    assert.strictEqual(results[1].isExternal, true);
  });

  test("Extract ES imports - default imports", () => {
    const text = `import React from 'react';\nimport path from 'path';`;
    const regex =
      /import\s+(?:(?:\{([^}]*)\}|(\w+))\s+from\s+)?['"]([^'"]+)['"]/g;

    const results: Array<{ symbols: string[]; module: string }> = [];
    let match;
    while ((match = regex.exec(text))) {
      const def = match[2] ? [match[2]] : [];
      results.push({ symbols: def, module: match[3] });
    }

    assert.strictEqual(results.length, 2);
    assert.deepStrictEqual(results[0].symbols, ["React"]);
    assert.strictEqual(results[0].module, "react");
    assert.deepStrictEqual(results[1].symbols, ["path"]);
  });

  test("Extract CommonJS requires", () => {
    const text = `const { readFile } = require('fs');\nconst express = require('express');`;
    const regex =
      /(?:const|let|var)\s+(?:\{([^}]*)\}|(\w+))\s*=\s*require\(['"]([^'"]+)['"]\)/g;

    const results: Array<{ symbols: string[]; module: string }> = [];
    let match;
    while ((match = regex.exec(text))) {
      const named = match[1] ? match[1].split(",").map((s) => s.trim()) : [];
      const def = match[2] ? [match[2]] : [];
      results.push({ symbols: [...def, ...named], module: match[3] });
    }

    assert.strictEqual(results.length, 2);
    assert.deepStrictEqual(results[0].symbols, ["readFile"]);
    assert.strictEqual(results[0].module, "fs");
    assert.deepStrictEqual(results[1].symbols, ["express"]);
  });

  // ─── Python Imports ───────────────────────────────────────────────

  test("Extract Python from-imports", () => {
    const text = `from flask import Flask, request\nfrom .utils import helper`;
    const regex = /^from\s+([\w.]+)\s+import\s+(.+)/gm;

    const results: Array<{
      module: string;
      symbols: string[];
      isRelative: boolean;
    }> = [];
    let match;
    while ((match = regex.exec(text))) {
      const mod = match[1];
      const symbols = match[2].split(",").map((s) => s.trim());
      results.push({ module: mod, symbols, isRelative: mod.startsWith(".") });
    }

    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].module, "flask");
    assert.deepStrictEqual(results[0].symbols, ["Flask", "request"]);
    assert.strictEqual(results[0].isRelative, false);
    assert.strictEqual(results[1].module, ".utils");
    assert.strictEqual(results[1].isRelative, true);
  });

  test("Extract Python import statements", () => {
    const text = `import os\nimport sys\nimport json`;
    const regex = /^import\s+([\w.]+)(?:\s+as\s+\w+)?$/gm;

    const modules: string[] = [];
    let match;
    while ((match = regex.exec(text))) {
      modules.push(match[1]);
    }

    assert.deepStrictEqual(modules, ["os", "sys", "json"]);
  });

  // ─── Go Imports ───────────────────────────────────────────────────

  test("Extract Go single imports", () => {
    const text = `import "fmt"\nimport "os"`;
    const regex = /^import\s+"([^"]+)"/gm;

    const modules: string[] = [];
    let match;
    while ((match = regex.exec(text))) {
      modules.push(match[1]);
    }

    assert.deepStrictEqual(modules, ["fmt", "os"]);
  });

  test("Extract Go block imports", () => {
    const text = `import (\n  "fmt"\n  "net/http"\n  "encoding/json"\n)`;
    const blockMatch = text.match(/import\s*\(([\s\S]*?)\)/);

    assert.ok(blockMatch, "Should find import block");
    const lines = blockMatch![1].split("\n");
    const imports: string[] = [];
    for (const line of lines) {
      const pathMatch = line.match(/"([^"]+)"/);
      if (pathMatch) imports.push(pathMatch[1]);
    }

    assert.deepStrictEqual(imports, ["fmt", "net/http", "encoding/json"]);
  });

  // ─── Export Detection ─────────────────────────────────────────────

  test("Detect TypeScript/JavaScript exports", () => {
    const lines = [
      "export function hello() {}",
      "export default class App {}",
      "function private() {}",
      "export const FOO = 1;",
      "module.exports = { bar };",
      "const internal = 42;",
    ];

    const exported = lines.filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed.startsWith("export ") ||
        trimmed.startsWith("export default ") ||
        trimmed.startsWith("module.exports")
      );
    });

    assert.strictEqual(exported.length, 4, "Should detect 4 exports");
  });

  test("Detect Python public symbols (no underscore prefix)", () => {
    const definitions = [
      { line: "def hello():", name: "hello" },
      { line: "def _private():", name: "_private" },
      { line: "class MyClass:", name: "MyClass" },
      { line: "class _InternalClass:", name: "_InternalClass" },
      { line: "def __init__(self):", name: "__init__" },
    ];

    const public_symbols = definitions.filter((d) => {
      const match = d.line.match(/^(?:def|class)\s+(\w+)/);
      return !!match && !match[1].startsWith("_");
    });

    assert.strictEqual(public_symbols.length, 2);
    assert.strictEqual(public_symbols[0].name, "hello");
    assert.strictEqual(public_symbols[1].name, "MyClass");
  });

  test("Detect Go exported symbols (uppercase first letter)", () => {
    const lines = [
      "func Hello() {}",
      "func helper() {}",
      "type Config struct {}",
      "type internal struct {}",
      "var MaxRetries int",
      "var count int",
    ];

    const exported = lines.filter((line) => {
      const match = line.match(/^(?:func|type|var|const)\s+(\w)/);
      return !!match && match[1] === match[1].toUpperCase();
    });

    assert.strictEqual(exported.length, 3);
    assert.ok(exported[0].includes("Hello"));
    assert.ok(exported[1].includes("Config"));
    assert.ok(exported[2].includes("MaxRetries"));
  });

  // ─── API Endpoint Detection ───────────────────────────────────────

  test("Detect Express-style routes", () => {
    const text = `
app.get('/api/users', handler);
router.post('/api/items', createItem);
app.delete('/api/users/:id', deleteUser);
`;
    const regex =
      /(?:app|router|server)\.(get|post|put|delete|patch|options|head)\s*\(\s*['"]([^'"]+)['"]/gi;

    const endpoints: Array<{ method: string; path: string }> = [];
    let match;
    while ((match = regex.exec(text))) {
      endpoints.push({ method: match[1].toUpperCase(), path: match[2] });
    }

    assert.strictEqual(endpoints.length, 3);
    assert.deepStrictEqual(endpoints[0], { method: "GET", path: "/api/users" });
    assert.deepStrictEqual(endpoints[1], {
      method: "POST",
      path: "/api/items",
    });
    assert.deepStrictEqual(endpoints[2], {
      method: "DELETE",
      path: "/api/users/:id",
    });
  });

  test("Detect Next.js App Router exports", () => {
    const text = `
export async function GET(req: Request) { }
export async function POST(req: Request) { }
export function DELETE(req: Request) { }
`;
    const regex =
      /export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*\(/g;

    const methods: string[] = [];
    let match;
    while ((match = regex.exec(text))) {
      methods.push(match[1]);
    }

    assert.deepStrictEqual(methods, ["GET", "POST", "DELETE"]);
  });

  test("Detect Python Flask/FastAPI routes", () => {
    const text = `
@app.get('/users')
def list_users():
    pass

@app.post('/users')
def create_user():
    pass

@app.route('/health')
def health():
    pass
`;
    const regex =
      /@(?:app|router)\.(route|get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g;

    const endpoints: Array<{ method: string; path: string }> = [];
    let match;
    while ((match = regex.exec(text))) {
      const method = match[1] === "route" ? "GET" : match[1].toUpperCase();
      endpoints.push({ method, path: match[2] });
    }

    assert.strictEqual(endpoints.length, 3);
    assert.deepStrictEqual(endpoints[0], { method: "GET", path: "/users" });
    assert.deepStrictEqual(endpoints[1], { method: "POST", path: "/users" });
    assert.deepStrictEqual(endpoints[2], { method: "GET", path: "/health" });
  });

  // ─── Next.js Route Derivation ────────────────────────────────────

  test("Derive Next.js routes from file paths", () => {
    function deriveNextJSRoute(filePath: string): string {
      let route = filePath
        .replace(/^(?:src\/)?app/, "")
        .replace(/\/route\.\w+$/, "")
        .replace(/\/page\.\w+$/, "");
      if (!route.startsWith("/")) route = "/" + route;
      return route || "/";
    }

    assert.strictEqual(
      deriveNextJSRoute("app/api/users/route.ts"),
      "/api/users",
    );
    assert.strictEqual(
      deriveNextJSRoute("app/api/users/[id]/route.ts"),
      "/api/users/[id]",
    );
    assert.strictEqual(
      deriveNextJSRoute("src/app/api/auth/route.ts"),
      "/api/auth",
    );
    assert.strictEqual(deriveNextJSRoute("app/page.tsx"), "/");
    assert.strictEqual(deriveNextJSRoute("app/about/page.tsx"), "/about");
  });
});
