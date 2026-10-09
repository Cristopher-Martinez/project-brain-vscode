#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const EXTENSIONS_ROOT = path.join(homedir(), ".vscode", "extensions");
const REGISTRY_PATH = path.join(EXTENSIONS_ROOT, "extensions.json");
const DRY_RUN = process.argv.includes("--dry-run");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function normalizeRegistryPath(rawPath) {
  if (!rawPath || typeof rawPath !== "string") {
    return null;
  }

  if (process.platform === "win32" && /^\/[a-zA-Z]:\//.test(rawPath)) {
    return path.normalize(rawPath.slice(1));
  }

  return path.normalize(rawPath);
}

function getExtensionId(pkg) {
  return `${pkg.publisher}.${pkg.name}`;
}

function readRegistryEntries() {
  if (!existsSync(REGISTRY_PATH)) {
    return [];
  }

  const parsed = readJson(REGISTRY_PATH);
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (Array.isArray(parsed?.extensions)) {
    return parsed.extensions;
  }

  return [];
}

function resolveActiveInstallDir(extensionId, packageVersion) {
  const registryEntries = readRegistryEntries();
  const activeEntry = [...registryEntries]
    .reverse()
    .find((entry) => entry?.identifier?.id === extensionId);

  const activePath = normalizeRegistryPath(activeEntry?.location?.path);
  if (activePath && existsSync(activePath)) {
    return {
      targetDir: activePath,
      source: "extensions.json",
      registeredVersion: activeEntry?.version ?? null,
    };
  }

  const preferredDir = path.join(
    EXTENSIONS_ROOT,
    `${extensionId}-${packageVersion}`,
  );
  if (existsSync(preferredDir)) {
    return {
      targetDir: preferredDir,
      source: "package-version-folder",
      registeredVersion: packageVersion,
    };
  }

  const candidates = readdirSync(EXTENSIONS_ROOT, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && entry.name.startsWith(`${extensionId}-`),
    )
    .map((entry) => {
      const fullPath = path.join(EXTENSIONS_ROOT, entry.name);
      return {
        fullPath,
        lastWriteMs: statSync(fullPath).mtimeMs,
      };
    })
    .sort((left, right) => right.lastWriteMs - left.lastWriteMs);

  if (candidates.length > 0) {
    return {
      targetDir: candidates[0].fullPath,
      source: "latest-installed-folder",
      registeredVersion: null,
    };
  }

  return {
    targetDir: preferredDir,
    source: "new-package-version-folder",
    registeredVersion: null,
  };
}

function hashFile(filePath) {
  return createHash("sha256")
    .update(readFileSync(filePath))
    .digest("hex");
}

function copyDirectoryReplacingTarget(sourceDir, targetDir) {
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
  }
  cpSync(sourceDir, targetDir, { recursive: true, force: true });
}

function ensureCopiedFile(sourceFile, targetFile) {
  if (!existsSync(targetFile)) {
    throw new Error(`Missing deployed file: ${targetFile}`);
  }

  const sourceHash = hashFile(sourceFile);
  const targetHash = hashFile(targetFile);
  if (sourceHash !== targetHash) {
    throw new Error(
      `Hash mismatch for ${path.basename(sourceFile)} (${sourceHash} != ${targetHash})`,
    );
  }
}

function copyOptionalDirectory(name, destinationRoot) {
  const sourceDir = path.join(ROOT, name);
  if (!existsSync(sourceDir)) {
    return;
  }

  copyDirectoryReplacingTarget(sourceDir, path.join(destinationRoot, name));
}

function main() {
  const pkg = readJson(path.join(ROOT, "package.json"));
  const extensionId = getExtensionId(pkg);
  const { targetDir, source, registeredVersion } = resolveActiveInstallDir(
    extensionId,
    pkg.version,
  );

  const sourceDist = path.join(ROOT, "dist");
  const targetDist = path.join(targetDir, "dist");
  const sourcePackage = path.join(ROOT, "package.json");
  const targetPackage = path.join(targetDir, "package.json");

  if (!existsSync(sourceDist)) {
    throw new Error("Local dist/ does not exist. Run npm run compile first.");
  }

  console.log(`Deploy source: ${ROOT}`);
  console.log(`Extension id: ${extensionId}`);
  console.log(`Package version: ${pkg.version}`);
  console.log(`Target source: ${source}`);
  console.log(`Target dir: ${targetDir}`);

  if (registeredVersion && registeredVersion !== pkg.version) {
    console.warn(
      `WARNING: VS Code registry reports version ${registeredVersion}, but package.json is ${pkg.version}. Deploying to the active folder anyway.`,
    );
  }

  if (DRY_RUN) {
    console.log("Dry run complete. No files were copied.");
    return;
  }

  mkdirSync(targetDir, { recursive: true });
  copyDirectoryReplacingTarget(sourceDist, targetDist);
  copyFileSync(sourcePackage, targetPackage);
  copyOptionalDirectory("static", targetDir);
  copyOptionalDirectory("media", targetDir);
  copyOptionalDirectory(".github", targetDir);

  ensureCopiedFile(path.join(sourceDist, "extension.js"), path.join(targetDist, "extension.js"));
  ensureCopiedFile(
    path.join(sourceDist, "webview-ui", "index.js"),
    path.join(targetDist, "webview-ui", "index.js"),
  );
  ensureCopiedFile(sourcePackage, targetPackage);

  console.log("Deploy verification passed.");
  console.log("Reload VS Code to activate the copied bundle.");
}

main();