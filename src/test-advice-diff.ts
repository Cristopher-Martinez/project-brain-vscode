import { createHash } from "crypto";
import { execFileSync } from "child_process";

const MAX_DIFF_CHARS = 2200;

export function readDiffSnippet(file: string, wsRoot: string): string {
  try {
    const diff = execFileSync("git", ["diff", "--unified=1", "--", file], {
      cwd: wsRoot,
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    return diff.length > 0 ? diff.slice(0, MAX_DIFF_CHARS) : "(no diff available)";
  } catch {
    return "(no diff available)";
  }
}

export function computeDiffFingerprint(file: string, wsRoot: string): string {
  return createHash("sha1").update(readDiffSnippet(file, wsRoot)).digest("hex");
}