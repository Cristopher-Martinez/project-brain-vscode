import { execFile } from "child_process";
import * as path from "path";
import { promisify } from "util";
import { log, logError, logWarn } from "./logger";

const execFileAsync = promisify(execFile);

const MAX_COMMITS = 500;
const GIT_TIMEOUT_MS = 30_000;

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface CommitInfo {
  hash: string;
  date: string;
  author: string;
  message: string;
  filesChanged: number;
}

export interface FileHotspot {
  file: string;
  commits: number;
  authors: string[];
  lastModified: string;
}

export interface FileCoupling {
  fileA: string;
  fileB: string;
  coChangeCount: number;
  /** Percentage of times fileA changed with fileB (0-100) */
  couplingStrength: number;
}

export interface GitInsights {
  isGitRepo: boolean;
  totalCommits: number;
  dateRange: { first: string; last: string } | null;
  activeAuthors: { name: string; commits: number }[];
  recentCommits: CommitInfo[];
  hotspots: FileHotspot[];
  /** Top file couplings (files that change together) */
  couplings: FileCoupling[];
  /** Files most recently and frequently modified — potential complexity zones */
  frequentlyChanged: string[];
  /** Detected primary language based on file extensions */
  primaryLanguages: { language: string; percentage: number }[];
}

// ─── GitAnalyzer ─────────────────────────────────────────────────────────────

export class GitAnalyzer {
  constructor(private rootPath: string) {}

  /**
   * Full analysis: commits, hotspots, couplings, language breakdown.
   * Gracefully returns empty insights if git is unavailable or this is not a repo.
   */
  async analyze(): Promise<GitInsights> {
    const empty: GitInsights = {
      isGitRepo: false,
      totalCommits: 0,
      dateRange: null,
      activeAuthors: [],
      recentCommits: [],
      hotspots: [],
      couplings: [],
      frequentlyChanged: [],
      primaryLanguages: [],
    };

    if (!(await this.isGitRepo())) {
      return empty;
    }

    try {
      const [commits, totalCount] = await Promise.all([
        this.getCommitLog(),
        this.getTotalCommitCount(),
      ]);

      const hotspots = await this.getHotspots();
      const couplings = this.computeCouplings(commits);
      const authors = this.aggregateAuthors(commits);
      const languages = await this.detectLanguages();

      const dateRange =
        commits.length > 0
          ? {
              first: commits[commits.length - 1].date,
              last: commits[0].date,
            }
          : null;

      const frequentlyChanged = hotspots.slice(0, 15).map((h) => h.file);

      return {
        isGitRepo: true,
        totalCommits: totalCount,
        dateRange,
        activeAuthors: authors,
        recentCommits: commits.slice(0, 30),
        hotspots: hotspots.slice(0, 30),
        couplings: couplings.slice(0, 20),
        frequentlyChanged,
        primaryLanguages: languages.slice(0, 8),
      };
    } catch (error) {
      logError("Git analysis failed", error);
      return { ...empty, isGitRepo: true };
    }
  }

  // ─── Internal ───────────────────────────────────────────────────

  private async isGitRepo(): Promise<boolean> {
    try {
      await this.git(["rev-parse", "--is-inside-work-tree"]);
      return true;
    } catch {
      return false;
    }
  }

  private async getTotalCommitCount(): Promise<number> {
    try {
      const { stdout } = await this.git(["rev-list", "--count", "HEAD"]);
      return parseInt(stdout.trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  private async getCommitLog(): Promise<(CommitInfo & { files: string[] })[]> {
    const SEP = "<<SEP>>";
    const format = `${SEP}%H|%aI|%aN|%s`;

    const { stdout } = await this.git([
      "log",
      `--max-count=${MAX_COMMITS}`,
      `--pretty=format:${format}`,
      "--name-only",
    ]);

    const commits: (CommitInfo & { files: string[] })[] = [];
    const blocks = stdout.split(SEP).filter((b) => b.trim());

    for (const block of blocks) {
      const lines = block.trim().split("\n");
      const headerLine = lines[0];
      const parts = headerLine.split("|");
      if (parts.length < 4) continue;

      const [hash, date, author, ...msgParts] = parts;
      const message = msgParts.join("|"); // handle | in commit message

      // Lines after header are changed file paths
      const files = lines
        .slice(1)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      commits.push({
        hash: hash.slice(0, 8),
        date: date.slice(0, 10), // YYYY-MM-DD
        author,
        message: message.slice(0, 120),
        filesChanged: files.length,
        files,
      });
    }

    return commits;
  }

  private async getHotspots(): Promise<FileHotspot[]> {
    // Use shortlog-like approach: count commits per file
    const { stdout } = await this.git([
      "log",
      `--max-count=${MAX_COMMITS}`,
      "--pretty=format:%aI|%aN",
      "--name-only",
    ]);

    const fileMap = new Map<
      string,
      { commits: number; authors: Set<string>; lastDate: string }
    >();

    const blocks = stdout.split(/\n\n+/);
    for (const block of blocks) {
      const lines = block.trim().split("\n");
      if (lines.length < 2) continue;

      const [header, ...files] = lines;
      const [date, author] = header.split("|");
      if (!date || !author) continue;

      for (const file of files) {
        const f = file.trim();
        if (!f) continue;

        const entry = fileMap.get(f) || {
          commits: 0,
          authors: new Set<string>(),
          lastDate: "",
        };
        entry.commits++;
        entry.authors.add(author);
        if (!entry.lastDate || date > entry.lastDate) {
          entry.lastDate = date.slice(0, 10);
        }
        fileMap.set(f, entry);
      }
    }

    // Sort by commit count descending
    return Array.from(fileMap.entries())
      .map(([file, data]) => ({
        file,
        commits: data.commits,
        authors: Array.from(data.authors),
        lastModified: data.lastDate,
      }))
      .sort((a, b) => b.commits - a.commits);
  }

  private computeCouplings(commits: { files: string[] }[]): FileCoupling[] {
    // Count co-occurrences: pairs of files that change in the same commit
    const pairCount = new Map<string, number>();
    const fileCount = new Map<string, number>();

    for (const commit of commits) {
      const files = commit.files.filter(
        (f) =>
          !f.includes("node_modules") &&
          !f.includes("package-lock") &&
          !f.includes(".lock"),
      );
      if (files.length < 2 || files.length > 20) continue; // skip trivial or massive commits

      for (const f of files) {
        fileCount.set(f, (fileCount.get(f) || 0) + 1);
      }

      // Generate pairs (sorted to avoid duplicates)
      for (let i = 0; i < files.length; i++) {
        for (let j = i + 1; j < files.length; j++) {
          const key =
            files[i] < files[j]
              ? `${files[i]}||${files[j]}`
              : `${files[j]}||${files[i]}`;
          pairCount.set(key, (pairCount.get(key) || 0) + 1);
        }
      }
    }

    // Convert to FileCoupling, filtering by minimum co-changes
    const couplings: FileCoupling[] = [];
    for (const [key, count] of pairCount.entries()) {
      if (count < 3) continue; // minimum 3 co-changes to be considered

      const [fileA, fileB] = key.split("||");
      const countA = fileCount.get(fileA) || 1;
      const strength = Math.round((count / countA) * 100);

      couplings.push({
        fileA,
        fileB,
        coChangeCount: count,
        couplingStrength: Math.min(strength, 100),
      });
    }

    return couplings.sort((a, b) => b.coChangeCount - a.coChangeCount);
  }

  private aggregateAuthors(
    commits: CommitInfo[],
  ): { name: string; commits: number }[] {
    const authorMap = new Map<string, number>();
    for (const c of commits) {
      authorMap.set(c.author, (authorMap.get(c.author) || 0) + 1);
    }

    return Array.from(authorMap.entries())
      .map(([name, commits]) => ({ name, commits }))
      .sort((a, b) => b.commits - a.commits);
  }

  private async detectLanguages(): Promise<
    { language: string; percentage: number }[]
  > {
    try {
      const { stdout } = await this.git([
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
      ]);

      const extCount = new Map<string, number>();
      let total = 0;

      for (const line of stdout.split("\n")) {
        const file = line.trim();
        if (!file) continue;
        const ext = path.extname(file).toLowerCase();
        if (!ext || ext === ".md" || ext === ".json" || ext === ".lock")
          continue;

        extCount.set(ext, (extCount.get(ext) || 0) + 1);
        total++;
      }

      const extToLang: Record<string, string> = {
        ".ts": "TypeScript",
        ".tsx": "TypeScript (React)",
        ".js": "JavaScript",
        ".jsx": "JavaScript (React)",
        ".py": "Python",
        ".rs": "Rust",
        ".go": "Go",
        ".java": "Java",
        ".kt": "Kotlin",
        ".rb": "Ruby",
        ".php": "PHP",
        ".cs": "C#",
        ".cpp": "C++",
        ".c": "C",
        ".swift": "Swift",
        ".vue": "Vue",
        ".svelte": "Svelte",
        ".scss": "SCSS",
        ".css": "CSS",
        ".html": "HTML",
        ".sql": "SQL",
        ".sh": "Shell",
        ".ps1": "PowerShell",
        ".yaml": "YAML",
        ".yml": "YAML",
        ".toml": "TOML",
      };

      return Array.from(extCount.entries())
        .map(([ext, count]) => ({
          language: extToLang[ext] || ext,
          percentage: Math.round((count / total) * 100),
        }))
        .sort((a, b) => b.percentage - a.percentage);
    } catch {
      return [];
    }
  }

  private async git(
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync("git", args, {
      cwd: this.rootPath,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
  }
}
