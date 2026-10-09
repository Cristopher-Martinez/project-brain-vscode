import { existsSync, readFileSync, readdirSync } from "fs";
import { basename, dirname, extname, join } from "path";

type DiscoveryMode = "generic" | "hook" | "execution";

interface DiscoveryRule {
  id: string;
  segments: string[];
  parentLevels?: number;
  rooted?: boolean;
  weight: number;
  modes: DiscoveryMode[];
}

interface DiscoveryConfig {
  candidateLocations: DiscoveryRule[];
  suffixes: string[];
  extensions: string[];
}

interface TestPattern {
  baseDir: string;
  suffix: string;
  extension: string;
  score: number;
}

const TEST_FILE_PATTERN = /^(.*)\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;
const DEFAULT_CONFIG: DiscoveryConfig = {
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

let cachedConfig: DiscoveryConfig | undefined;

export function deriveSuggestedTestPath(file: string, wsRoot: string): string {
  const sourceExt = extname(file);
  const sourceStem = basename(file, sourceExt);
  const sourceDir = dirname(file);
  const pattern = inferNearbyPattern(file, wsRoot, selectMode(file, wsRoot));
  return buildPatternPath(sourceDir, sourceStem, sourceExt, pattern);
}

export function findExistingRelatedTestPath(
  file: string,
  wsRoot: string,
): string | undefined {
  return buildCandidatePaths(file, wsRoot, "execution").find((candidate) => existsSync(candidate));
}

export function listRelatedTestDirectories(
  file: string,
  wsRoot: string,
  mode: DiscoveryMode = "execution",
): string[] {
  const sourceDir = dirname(file);
  const config = readDiscoveryConfig();
  return config.candidateLocations
    .filter((rule) => rule.modes.includes(mode))
    .map((rule) => resolveRuleDirectory(rule, sourceDir, wsRoot));
}

function inferNearbyPattern(
  file: string,
  wsRoot: string,
  mode: DiscoveryMode,
): TestPattern | undefined {
  const sourceExt = extname(file);
  const directories = listRelatedTestDirectories(file, wsRoot, mode).map((path, index) => ({
    path,
    weight: readDiscoveryConfig().candidateLocations.filter((rule) => rule.modes.includes(mode))[index]?.weight ?? 0,
  }));

  let best: TestPattern | undefined;
  for (const directory of directories) {
    const pattern = readPatternFromDirectory(directory.path, directory.weight, sourceExt);
    if (!pattern || (best && best.score >= pattern.score)) {
      continue;
    }
    best = pattern;
  }
  return best;
}

function readPatternFromDirectory(
  directory: string,
  weight: number,
  sourceExt: string,
): TestPattern | undefined {
  if (!existsSync(directory)) {
    return undefined;
  }

  try {
    const firstMatch = readdirSync(directory).find((entry) => TEST_FILE_PATTERN.test(entry));
    if (!firstMatch) {
      return undefined;
    }
    const match = firstMatch.match(TEST_FILE_PATTERN);
    if (!match) {
      return undefined;
    }
    const suffix = match[2] === "spec" ? "spec" : "test";
    const extension = `.${match[3]}`;
    return {
      baseDir: directory,
      suffix,
      extension,
      score: weight + (extension === sourceExt ? 2 : 0),
    };
  } catch {
    return undefined;
  }
}

function buildCandidatePaths(
  file: string,
  wsRoot: string,
  mode: DiscoveryMode,
): string[] {
  const config = readDiscoveryConfig();
  const sourceExt = extname(file);
  const sourceStem = basename(file, sourceExt);
  const sourceDir = dirname(file);
  const extensions = [sourceExt, ...config.extensions].filter(Boolean);
  const candidates = [buildPatternPath(sourceDir, sourceStem, sourceExt, inferNearbyPattern(file, wsRoot, mode))];
  for (const directory of listRelatedTestDirectories(file, wsRoot, mode)) {
    for (const suffix of config.suffixes) {
      for (const extension of extensions) {
        candidates.push(join(directory, `${sourceStem}.${suffix}${extension}`));
      }
    }
  }
  return [...new Set(candidates)];
}

function buildPatternPath(
  sourceDir: string,
  stem: string,
  sourceExt: string,
  pattern?: TestPattern,
): string {
  if (!pattern) {
    return join(sourceDir, "__tests__", `${stem}.test${sourceExt}`);
  }

  return join(pattern.baseDir, `${stem}.${pattern.suffix}${pattern.extension}`);
}

function readDiscoveryConfig(): DiscoveryConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  for (const candidate of [
    join(__dirname, "..", ".github", "hooks", "scripts", "lib", "test-discovery-patterns.json"),
    join(__dirname, "..", "static", "hooks", "scripts", "lib", "test-discovery-patterns.json"),
  ]) {
    try {
      if (!existsSync(candidate)) {
        continue;
      }
      cachedConfig = JSON.parse(readFileSync(candidate, "utf8")) as DiscoveryConfig;
      return cachedConfig;
    } catch {
      // Fall back to defaults below.
    }
  }

  cachedConfig = DEFAULT_CONFIG;
  return cachedConfig;
}

function resolveRuleDirectory(rule: DiscoveryRule, sourceDir: string, wsRoot: string): string {
  if (rule.rooted) {
    return join(wsRoot, ...rule.segments);
  }

  let baseDir = sourceDir;
  for (let index = 0; index < (rule.parentLevels ?? 0); index += 1) {
    baseDir = dirname(baseDir);
  }
  return join(baseDir, ...rule.segments);
}

function selectMode(file: string, wsRoot: string): DiscoveryMode {
  const relativePath = file.replace(`${wsRoot}\\`, "").replace(`${wsRoot}/`, "").replace(/\\/g, "/");
  if (
    relativePath.startsWith(".project-brain/hooks/scripts/") ||
    relativePath.startsWith(".github/hooks/scripts/") ||
    relativePath.startsWith("static/hooks/scripts/")
  ) {
    return "hook";
  }
  return "generic";
}