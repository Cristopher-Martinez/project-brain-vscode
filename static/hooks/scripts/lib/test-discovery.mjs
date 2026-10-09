import { existsSync, readFileSync } from "fs";
import { basename, dirname, extname, isAbsolute, join, relative } from "path";
import { fileURLToPath } from "url";

const TEST_FILE_PATTERN = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;
const DEFAULT_CONFIG = {
  candidateLocations: [
    { id: "same-dir", segments: [], parentLevels: 0, weight: 5, modes: ["generic", "hook", "execution"] },
    { id: "local-tests", segments: ["__tests__"], parentLevels: 0, weight: 4, modes: ["generic", "hook", "execution"] },
    { id: "parent-tests", segments: ["__tests__"], parentLevels: 1, weight: 3, modes: ["generic", "hook", "execution"] },
    { id: "src-root-tests", segments: ["src", "__tests__"], rooted: true, weight: 2, modes: ["generic", "execution"] },
    { id: "root-tests", segments: ["__tests__"], rooted: true, weight: 1, modes: ["generic", "execution"] },
    { id: "hook-tests-root", segments: [".github", "hooks", "scripts", "__tests__"], rooted: true, weight: 6, modes: ["hook", "execution"] },
    { id: "static-hook-tests-root", segments: ["static", "hooks", "scripts", "__tests__"], rooted: true, weight: 6, modes: ["hook", "execution"] },
  ],
  suffixes: ["test", "spec"],
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
};

let cachedConfig;

export function isTestFile(filePath) {
  return TEST_FILE_PATTERN.test(normalizePath(filePath));
}

export function buildCandidateTestPaths(file, cwd) {
  const sourcePath = resolveSourcePath(file, cwd);
  const sourceExt = extname(sourcePath) || inferExtension(file);
  const sourceStem = basename(sourcePath, sourceExt);
  const mode = selectMode(file, cwd);
  const candidateDirs = listCandidateDirs(sourcePath, cwd, mode);
  const config = readDiscoveryConfig();
  const variants = [];
  for (const dir of candidateDirs) {
    for (const suffix of config.suffixes) {
      for (const extension of buildExtensions(sourceExt, config.extensions)) {
        variants.push(join(dir, `${sourceStem}.${suffix}${extension}`));
      }
    }
  }
  return [...new Set(variants)];
}

export function findExistingRelatedTestPath(file, cwd) {
  return buildCandidateTestPaths(file, cwd).find((candidate) => existsSync(candidate));
}

export function hasCoEditedRelatedTest(file, editedFiles, cwd) {
  const editedLookup = new Set();
  for (const edited of editedFiles) {
    const normalized = normalizePath(edited).toLowerCase();
    editedLookup.add(normalized);
    editedLookup.add(basename(normalized));
  }
  return buildCandidateTestPaths(file, cwd).some((candidate) => {
    const relativeCandidate = normalizePath(relative(cwd, candidate)).toLowerCase();
    return editedLookup.has(relativeCandidate) || editedLookup.has(basename(relativeCandidate));
  });
}

export function looksLikeHookTest(testFile) {
  const normalized = normalizePath(testFile);
  return (
    normalized.includes("/.github/hooks/scripts/__tests__/") ||
    normalized.includes("/static/hooks/scripts/__tests__/")
  );
}

function resolveSourcePath(file, cwd) {
  if (isAbsolute(file)) {
    return file;
  }
  return join(cwd, normalizePath(file));
}

function buildExtensions(sourceExt, knownExtensions) {
  const preferred = sourceExt || ".ts";
  return [...new Set([preferred, ...knownExtensions])];
}

function inferExtension(file) {
  const normalized = normalizePath(file);
  const match = normalized.match(/(\.[^.\/]+)$/);
  return match ? match[1] : ".ts";
}

function normalizePath(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

function listCandidateDirs(sourcePath, cwd, mode) {
  const sourceDir = dirname(sourcePath);
  const config = readDiscoveryConfig();
  return config.candidateLocations
    .filter((rule) => rule.modes.includes(mode) || rule.modes.includes("execution"))
    .map((rule) => resolveRuleDirectory(rule, sourceDir, cwd));
}

function resolveRuleDirectory(rule, sourceDir, cwd) {
  if (rule.rooted) {
    return join(cwd, ...rule.segments);
  }
  let baseDir = sourceDir;
  for (let index = 0; index < (rule.parentLevels || 0); index += 1) {
    baseDir = dirname(baseDir);
  }
  return join(baseDir, ...rule.segments);
}

function readDiscoveryConfig() {
  if (cachedConfig) {
    return cachedConfig;
  }
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const configPath = join(moduleDir, "test-discovery-patterns.json");
  try {
    if (existsSync(configPath)) {
      cachedConfig = JSON.parse(readFileSync(configPath, "utf8"));
      return cachedConfig;
    }
  } catch {
    // Fall through to defaults.
  }
  cachedConfig = DEFAULT_CONFIG;
  return cachedConfig;
}

function selectMode(file, cwd) {
  const relativePath = normalizePath(relative(cwd, resolveSourcePath(file, cwd)));
  if (
    relativePath.startsWith(".github/hooks/scripts/") ||
    relativePath.startsWith("static/hooks/scripts/") ||
    basename(relativePath).endsWith(".mjs")
  ) {
    return "hook";
  }
  return "generic";
}