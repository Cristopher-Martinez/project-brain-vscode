/**
 * Extracted helper functions for post-tool-capture.mjs.
 * Handles edit checks, knowledge injection, prompt context, and domain extraction.
 */
import { existsSync, readFileSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { recordAuditAction, recordEditedFile } from "./audit-gate.mjs";
import { analyzeForDiscipline } from "./code-discipline.mjs";
import { recordCommitEdit } from "./commit-gate.mjs";
import {
  appendEditTracker,
  appendPipelineEdit,
  readAndClearEditTracker,
  readKnowledgeSummary,
  readPipelineEdits,
  safeRead,
} from "./fs-utils.mjs";
import { readAllActiveLoops } from "./loop-utils.mjs";
import { findRelevantOpinions } from "./opinion-parser.mjs";
import { detectPipelineGapsFromConfig } from "./pipeline-config.mjs";
import { sanitizeContent, sanitizeForInjection } from "./sanitize.mjs";
import { querySearchCache } from "./search-cache.mjs";
import {
  getTopNotesForInjection,
  recordHits,
  writeNote,
} from "./temporal-mailbox.mjs";

import { writeFileSync, appendFileSync } from "fs";

/**
 * Append to a session-scoped edit tracker file.
 * This prevents cross-session contamination of edit tracking data.
 * @param {string} sessionsDir
 * @param {string} sessionId
 * @param {string[]} filenames - basenames of edited files
 */
function sessionScopedEditTracker(sessionsDir, sessionId, filenames) {
  if (!sessionId || !filenames.length) return;
  try {
    const tracker = join(sessionsDir, `edit-tracker-${sessionId.slice(0, 8)}.txt`);
    appendFileSync(tracker, filenames.join("\n") + "\n");
  } catch { /* non-fatal */ }
}


/** Tools that produce file edits. */
export const EDIT_TOOLS = [
  "replace_string_in_file",
  "multi_replace_string_in_file",
  "create_file",
];

/** Tools that count as audit/read actions (verifying code). */
export const READ_TOOLS = [
  "run_in_terminal",
  "projectBrain_toolbox",
  "projectBrain_semanticSearch",
  "projectBrain_findFiles",
  "projectBrain_listDir",
  "projectBrain_getErrors",
  "tool_search_tool_regex",
];

/** Get file paths from tool input (handles single and multi-replace). */
export function getEditPaths(toolName, toolInput) {
  return toolName === "multi_replace_string_in_file"
    ? (toolInput.replacements || []).map((r) => r.filePath).filter(Boolean)
    : [toolInput.filePath].filter(Boolean);
}

/** Check edited files in src/ for >400 lines. Returns warning string or "". */
export function checkFileSizes(toolName, toolInput) {
  const filePaths = getEditPaths(toolName, toolInput);
  const warnings = [];
  for (const fp of [...new Set(filePaths)]) {
    if (!/[/\\]src[/\\]/.test(fp)) continue;
    try {
      if (!existsSync(fp)) continue;
      const content = readFileSync(fp, "utf8");
      const lineCount = content.split("\n").length;
      if (lineCount > 400) {
        warnings.push(
          `🚨 ${fp.split(/[/\\]/).pop()} has ${lineCount} lines (MAX 400). SPLIT NOW.`,
        );
      } else if (lineCount > 350) {
        warnings.push(
          `⚠️ ${fp.split(/[/\\]/).pop()} has ${lineCount} lines (approaching 400 limit). Plan a split.`,
        );
      }
    } catch {}
  }
  return warnings.length > 0 ? `FILE SIZE ALERT:\n${warnings.join("\n")}` : "";
}

/** Track edited files for domain-aware injection and audit gate. */
export function trackEditedFiles(toolName, toolInput, sessionsDir, cwd) {
  const editedPaths = getEditPaths(toolName, toolInput);
  for (const fp of editedPaths) {
    appendEditTracker(sessionsDir, fp);
    const basename = (fp || "").split(/[/\\]/).pop() || "";
    appendPipelineEdit(sessionsDir, basename);
  }
  try {
    const activeLoops = readAllActiveLoops(cwd);
    // Only register edits for the MOST RECENT loop to prevent cross-session contamination.
    if (activeLoops.length > 0) {
      const mostRecent = activeLoops[activeLoops.length - 1];
      if (mostRecent.sessionId) {
        recordEditedFile(
          cwd,
          mostRecent.sessionId,
          editedPaths
            .map((fp) => (fp || "").split(/[\/\\]/).pop() || "")
            .filter(Boolean),
        );
        // Also track for commit gate
        recordCommitEdit(cwd, mostRecent.sessionId, editedPaths.filter(Boolean));
        // Session-scoped edit tracking (prevents cross-session contamination)
        sessionScopedEditTracker(sessionsDir, mostRecent.sessionId,
          editedPaths.map((fp) => (fp || "").split(/[\/\\]/).pop() || "").filter(Boolean));
      }
    }
  } catch {}
}

/** Track read/verify actions for audit gate enforcement. */
export function trackAuditActions(toolName, cwd) {
  if (!READ_TOOLS.includes(toolName)) return;
  try {
    const activeLoops = readAllActiveLoops(cwd);
    // Only register audit actions for the MOST RECENT loop.
    if (activeLoops.length > 0) {
      const mostRecent = activeLoops[activeLoops.length - 1];
      if (mostRecent.sessionId) {
        recordAuditAction(cwd, mostRecent.sessionId);
      }
    }
  } catch {}
}


/**
 * Unified post-tool action tracker — reads loops ONCE and handles both edits and audit actions.
 * Use this instead of calling trackEditedFiles + trackAuditActions separately.
 * @param {string} toolName
 * @param {object} toolInput
 * @param {string} sessionsDir
 * @param {string} cwd
 */
export function trackPostToolActions(toolName, toolInput, sessionsDir, cwd) {
  const isEditTool = EDIT_TOOLS.includes(toolName);
  const isReadTool = READ_TOOLS.includes(toolName);
  if (!isEditTool && !isReadTool) return;

  // Read loops ONCE for both operations
  let mostRecent = null;
  try {
    const activeLoops = readAllActiveLoops(cwd);
    if (activeLoops.length > 0) {
      mostRecent = activeLoops[activeLoops.length - 1];
    }
  } catch {}

  if (isEditTool) {
    const editedPaths = getEditPaths(toolName, toolInput);
    for (const fp of editedPaths) {
      appendEditTracker(sessionsDir, fp);
      const basename = (fp || "").split(/[\/\\]/).pop() || "";
      appendPipelineEdit(sessionsDir, basename);
    }
    if (mostRecent?.sessionId) {
      recordEditedFile(
        cwd,
        mostRecent.sessionId,
        editedPaths.map((fp) => (fp || "").split(/[\/\\]/).pop() || "").filter(Boolean),
      );
      recordCommitEdit(cwd, mostRecent.sessionId, editedPaths.filter(Boolean));
      sessionScopedEditTracker(sessionsDir, mostRecent.sessionId,
        editedPaths.map((fp) => (fp || "").split(/[\/\\]/).pop() || "").filter(Boolean));
    }
  }

  if (isReadTool && mostRecent?.sessionId) {
    recordAuditAction(cwd, mostRecent.sessionId);
  }
}

/** Pipeline Integration Audit — checks for gaps in multi-file edits. */
export function buildPipelineAudit(sessionsDir, cwd) {
  try {
    const pipelineEdits = readPipelineEdits(sessionsDir);
    if (pipelineEdits.length < 2) return "";
    const editList = pipelineEdits.map((f) => `  ✏️ ${f}`).join("\n");
    const configGaps = detectPipelineGapsFromConfig(cwd, pipelineEdits);
    const missingChecks =
      configGaps.length > 0
        ? configGaps.map((g) => `❓ ${g}`)
        : buildHardcodedGapChecks(pipelineEdits);
    const missingBlock =
      missingChecks.length > 0
        ? `\nPotential gaps:\n${missingChecks.join("\n")}`
        : "";
    return `🔗 PIPELINE AUDIT — ${pipelineEdits.length} pipeline files edited this session:\n${editList}${missingBlock}\nBefore finishing: verify return values of fallible calls, check symmetry across sibling components, walk each user action through the full pipeline.`;
  } catch {}
  return "";
}

/** Code Discipline Verification — checks edited files for code smells. */
export function checkCodeDiscipline(toolName, toolInput) {
  try {
    const editedPaths = getEditPaths(toolName, toolInput);
    const newCodes =
      toolName === "multi_replace_string_in_file"
        ? (toolInput.replacements || []).map((r) => r.newString || "")
        : [toolInput.newString || toolInput.content || ""];
    const allWarnings = [];
    for (let i = 0; i < editedPaths.length; i++) {
      const fp = editedPaths[i];
      const newCode = newCodes[i] || "";
      if (!fp || !existsSync(fp)) continue;
      try {
        const fullContent = readFileSync(fp, "utf8");
        const warnings = analyzeForDiscipline(fullContent, newCode, fp);
        allWarnings.push(...warnings);
      } catch {}
    }
    return allWarnings.length > 0
      ? `🚨 CODE DISCIPLINE CHECK:\n${allWarnings.join("\n")}`
      : "";
  } catch {}
  return "";
}

/** Prompt Context Injection — reads signal from UserPromptSubmit writer hook. */
export function readPromptContext(sessionsDir) {
  try {
    const promptCtxFile = join(sessionsDir, "prompt-context.json");
    if (!existsSync(promptCtxFile)) return "";
    const stat = statSync(promptCtxFile);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs >= 5 * 60 * 1000) {
      try {
        unlinkSync(promptCtxFile);
      } catch {}
      return "";
    }
    const signal = JSON.parse(readFileSync(promptCtxFile, "utf8"));
    const parts = [];
    if (signal.troubleshooting?.length > 0) {
      const troubleHints = signal.troubleshooting.map(
        (e) =>
          `  - **${e.title}**: ${e.snippet.split("\n").slice(1, 4).join(" ").substring(0, 200)}`,
      );
      parts.push(
        `🔍 RELEVANT TROUBLESHOOTING (auto-detected from prompt):\n${troubleHints.join("\n")}`,
      );
    }
    if (signal.learnings?.length > 0) {
      const learnHints = signal.learnings.map((e) => `  - ${e.title}`);
      parts.push(`📚 RELEVANT LEARNINGS:\n${learnHints.join("\n")}`);
    }
    if (signal.fuzzyMatches) {
      parts.push(
        `🧠 OPINIONS & RELATED KNOWLEDGE (fuzzy match):\n${signal.fuzzyMatches}`,
      );
    }
    try {
      unlinkSync(promptCtxFile);
    } catch {}
    return parts.length > 0 ? parts.join("\n") : "";
  } catch {}
  return "";
}

/** Build knowledge refresh block (every N tool calls). */
export function buildKnowledgeBlock(
  sessionCallCount,
  effectiveInterval,
  memDir,
  sessionsDir,
) {
  try {
    if (sessionCallCount <= 0 || sessionCallCount % effectiveInterval !== 0)
      return "";
    let block = "";
    const summary = readKnowledgeSummary(memDir);
    if (summary) {
      block = `\nKNOWLEDGE REFRESH (call #${sessionCallCount}):\n${sanitizeContent(summary)}`;
    } else {
      const prefs = safeRead(join(memDir, "11_PROGRAMMING_PREFS.md"), 400);
      if (prefs)
        block = `\nPREFS REFRESH:\n${sanitizeForInjection(prefs, 400)}`;
    }
    const editedFiles = readAndClearEditTracker(sessionsDir);
    if (editedFiles.length > 0) {
      const domainKeywords = extractDomains(editedFiles);
      if (domainKeywords.length > 0) {
        const domainOpinions = findRelevantOpinions(memDir, domainKeywords, {
          searchCache: querySearchCache,
        });
        if (domainOpinions) {
          block += `\n\nFOCUS AREA HINTS (based on files you're editing: ${editedFiles.slice(0, 5).join(", ")}):\n${domainOpinions}`;
        }
      }
    }
    try {
      const { notes, formatted } = getTopNotesForInjection(sessionsDir, 5);
      if (formatted) {
        block += `\n${formatted}`;
        recordHits(
          sessionsDir,
          notes.map((n) => n.id),
        );
      }
    } catch {}
    return block;
  } catch {}
  return "";
}

/** Auto-capture edit operations to temporal mailbox (Tesseract mechanical enforcement). */
export function autoCaptureTesseract(
  toolName,
  toolInput,
  sessionCallCount,
  sessionsDir,
) {
  try {
    if (!EDIT_TOOLS.includes(toolName) || sessionCallCount <= 3) return;
    const paths = getEditPaths(toolName, toolInput);
    const basenames = [
      ...new Set(
        paths.map((p) => (p || "").split(/[\\/]/).pop()).filter(Boolean),
      ),
    ];
    if (basenames.length === 0) return;
    const explanation =
      toolInput.explanation || (toolInput.newString || "").slice(0, 60);
    const autoText = `Editado: ${basenames.join(", ")}${explanation ? " — " + explanation.slice(0, 80) : ""}`;
    writeNote(sessionsDir, autoText, 0.35, basenames);
  } catch {}
}

/** Extract domain keywords from file basenames. */
function extractDomains(fileNames) {
  const stopWords = new Set([
    "ts",
    "mjs",
    "js",
    "md",
    "json",
    "index",
    "src",
    "lib",
    "the",
    "and",
  ]);
  const keywords = new Set();
  for (const name of fileNames) {
    const parts = name.replace(/\.[^.]+$/, "").split(/[-_./\\]+/);
    for (const p of parts) {
      if (p.length > 2 && !stopWords.has(p)) keywords.add(p.toLowerCase());
    }
  }
  return [...keywords].slice(0, 10);
}

/** Hardcoded pipeline gap checks (fallback when no pipeline-config.json). */
function buildHardcodedGapChecks(pipelineEdits) {
  const editSet = new Set(pipelineEdits.map((f) => f.toLowerCase()));
  const checks = [];
  if (editSet.has("messages.ts") && !editSet.has("brain-hq-message-handler.ts"))
    checks.push(
      "❓ Added new WebviewToExtension message types? Check routing switch in brain-hq-message-handler.ts",
    );
  if (editSet.has("messages.ts") && !editSet.has("messagehandler.ts"))
    checks.push(
      "❓ Added new ExtensionToWebview message types? Check dispatch case in messageHandler.ts",
    );
  if (editSet.has("reducer.ts") && !editSet.has("messages.ts"))
    checks.push("❓ New reducer action? Verify type is defined in messages.ts");
  if (editSet.has("messagehandler.ts") && !editSet.has("reducer.ts"))
    checks.push(
      "❓ New dispatch case? Verify action type + reducer case exist in reducer.ts",
    );
  if (editSet.has("brain-hq-message-handler.ts") && !editSet.has("messages.ts"))
    checks.push(
      "❓ New routing entries? Verify message types exist in messages.ts",
    );
  const handlerPattern = /^brain-hq-\w+-handler\.ts$/;
  const hasHandler = [...editSet].some(
    (f) => handlerPattern.test(f) && f !== "brain-hq-message-handler.ts",
  );
  if (hasHandler && !editSet.has("brain-hq-message-handler.ts"))
    checks.push(
      "❓ New handler cases? Ensure routing switch in brain-hq-message-handler.ts includes them",
    );
  return checks;
}
