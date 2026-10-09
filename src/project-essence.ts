// ─── Project Essence Extractor ───────────────────────────────────────────────
// Extracted from AgentIdentityManager — Feature Envy smell eliminated.
// This module owns PROJECT DETECTION: reads package.json, tsconfig,
// requirements.txt, Cargo.toml, go.mod etc. to derive the tech stack.
// It's pure I/O + heuristics — no identity/soul/user concerns.

import * as fs from "fs";
import * as path from "path";

import { ProjectEssence } from "./identity-types";

/**
 * Extract project essence from repo files.
 * Auto-derived from filesystem — never manually configured.
 * Reads package.json, tsconfig, requirements.txt, Cargo.toml, go.mod.
 *
 * @param rootPath - Absolute path to the workspace/project root
 * @returns ProjectEssence with detected stack, or null if unrecognizable
 */
export function extractProjectEssence(rootPath: string): ProjectEssence | null {
  // Try package.json first (Node.js ecosystem)
  const pkgPath = path.join(rootPath, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };
      const depNames = Object.keys(allDeps || {});

      // Detect project type
      let projectType = "Node.js";
      const frameworks: string[] = [];
      const languages: string[] = [];

      // TypeScript?
      if (
        allDeps.typescript ||
        fs.existsSync(path.join(rootPath, "tsconfig.json"))
      ) {
        languages.push("TypeScript");
      } else {
        languages.push("JavaScript");
      }

      // Framework detection
      if (allDeps.react) {
        projectType = "React";
        frameworks.push("React");
      }
      if (allDeps.next) {
        projectType = "Next.js";
        frameworks.push("Next.js");
      }
      if (allDeps.vue) {
        projectType = "Vue.js";
        frameworks.push("Vue.js");
      }
      if (allDeps.nuxt) {
        projectType = "Nuxt";
        frameworks.push("Nuxt");
      }
      if (allDeps.svelte) {
        projectType = "Svelte";
        frameworks.push("Svelte");
      }
      if (allDeps.express) frameworks.push("Express");
      if (allDeps.fastify) frameworks.push("Fastify");
      if (allDeps.nestjs || allDeps["@nestjs/core"]) {
        projectType = "NestJS";
        frameworks.push("NestJS");
      }
      if (allDeps.electron) {
        projectType = "Electron";
        frameworks.push("Electron");
      }
      if (allDeps.esbuild) frameworks.push("esbuild");
      if (allDeps.webpack) frameworks.push("webpack");
      if (allDeps.vite) frameworks.push("Vite");
      if (allDeps.prisma || allDeps["@prisma/client"])
        frameworks.push("Prisma");
      if (allDeps.drizzle || allDeps["drizzle-orm"])
        frameworks.push("Drizzle");
      if (allDeps.tailwindcss) frameworks.push("Tailwind CSS");
      if (allDeps.jest) frameworks.push("Jest");
      if (allDeps.vitest) frameworks.push("Vitest");
      if (allDeps.mocha) frameworks.push("Mocha");

      // VS Code extension?
      if (pkg.engines?.vscode || allDeps["@types/vscode"]) {
        projectType = "VS Code Extension";
        frameworks.push("VS Code Extension API");
      }

      // Key dependencies (top 10, skip @types/ and dev tooling)
      const keyDeps = depNames
        .filter(
          (d) =>
            !d.startsWith("@types/") &&
            ![
              "typescript",
              "eslint",
              "prettier",
              "esbuild",
              "webpack",
              "vite",
              "jest",
              "vitest",
              "mocha",
            ].includes(d),
        )
        .slice(0, 10);

      return {
        projectType,
        languages,
        frameworks,
        description: pkg.description || "",
        keyDependencies: keyDeps,
      };
    } catch {
      // Parse error — continue to other detectors
    }
  }

  // Python
  const reqPath = path.join(rootPath, "requirements.txt");
  if (fs.existsSync(reqPath)) {
    try {
      const content = fs.readFileSync(reqPath, "utf-8");
      const deps = content
        .split("\n")
        .filter((l) => l.trim() && !l.startsWith("#"))
        .map((l) => l.split("==")[0].split(">=")[0].trim());
      const frameworks: string[] = [];
      if (deps.includes("django")) frameworks.push("Django");
      if (deps.includes("flask")) frameworks.push("Flask");
      if (deps.includes("fastapi")) frameworks.push("FastAPI");
      if (deps.includes("pytorch") || deps.includes("torch"))
        frameworks.push("PyTorch");
      if (deps.includes("tensorflow")) frameworks.push("TensorFlow");
      return {
        projectType: "Python",
        languages: ["Python"],
        frameworks,
        description: "",
        keyDependencies: deps.slice(0, 10),
      };
    } catch {
      /* continue */
    }
  }

  // Rust
  if (fs.existsSync(path.join(rootPath, "Cargo.toml"))) {
    return {
      projectType: "Rust",
      languages: ["Rust"],
      frameworks: [],
      description: "",
      keyDependencies: [],
    };
  }

  // Go
  if (fs.existsSync(path.join(rootPath, "go.mod"))) {
    return {
      projectType: "Go",
      languages: ["Go"],
      frameworks: [],
      description: "",
      keyDependencies: [],
    };
  }

  return null;
}
