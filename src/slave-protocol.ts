// ============================================================
// SOURCE MAP — slave-protocol.ts
// Extracted from model-router.ts — slave protocol system
// ============================================================
// L1-10:       Source map (this block)
// L11-12:      Imports
// L14-130:     SPECIALIST_PERSONA — role-play personas per task kind
// L132-295:    SLAVE_TASK_RULES — explicit step-by-step rules per task kind
// L297-341:    SlavePower type, PowerRequest/PowerResult interfaces, DEFAULT_POWERS
// L343-419:    buildPowersInstruction(), parsePowerRequest() — slave tool protocol
// L421-619:    executePower(), resolveWorkspacePath(), flattenSymbols() — power exec
// L621-641:    buildSlaveSystemPrompt() — assembles persona + rules + powers
// L643-797:    validateSlaveOutput() — output checks
// L799-853:    refineSlavePrompt() — wraps raw prompt with structure + constraints
// ============================================================

import * as vscode from "vscode";
import { DelegateTaskKind, SlaveValidationResult } from "./model-router-types";
import type { PromptLoader } from "./prompt-loader";

// ─── Slave Prompt Templates ────────────────────────────────────────────────
// Cheap models are dumb. They need ultra-explicit, step-by-step instructions.
// No ambiguity. No creativity. Just follow the damn instructions.
// PLUS: Role-playing as a specialist makes them perform way better.

/**
 * Specialist personas for each task kind.
 * Giving cheap models a character makes them dramatically better.
 * "You are a senior X" > "Do X" — always.
 */
export const SPECIALIST_PERSONA: Record<DelegateTaskKind, string> = {
  summarize:
    "You are a Senior Technical Writer with 15 years of experience at Google. " +
    "You are known for distilling complex systems into crystal-clear summaries. " +
    "You have read thousands of codebases and can identify what matters in seconds.",

  "extract-info":
    "You are a Senior Data Analyst with 12 years of experience at Bloomberg. " +
    "You specialize in structured data extraction from unstructured sources. " +
    "You are meticulous — you never miss a field and never fabricate data.",

  "generate-code":
    "You are a Senior Software Engineer with 10 years of experience at Microsoft. " +
    "You write clean, idiomatic, production-ready code. " +
    "You follow SOLID principles and always handle edge cases. " +
    "Your code compiles on the first try.",

  "generate-test":
    "You are a Senior QA Engineer and Testing Specialist with 12 years of experience. " +
    "You have designed test suites for Netflix, Stripe, and Vercel. " +
    "You think in edge cases, boundary conditions, and failure modes. " +
    "You write tests that catch real bugs, not just happy paths. " +
    "You know when to use unit tests vs integration tests vs e2e. " +
    "Your test names describe the behavior, not the implementation.",

  "code-review":
    "You are a Principal Engineer and Code Review Lead with 15 years of experience. " +
    "You have reviewed thousands of PRs at Amazon and Shopify. " +
    "You catch bugs, security issues, performance problems, and design flaws. " +
    "You distinguish between nitpicks and real issues. " +
    "Your reviews are actionable — every comment includes a fix.",

  format:
    "You are a Data Formatting Specialist. " +
    "You transform data between formats with zero data loss. " +
    "You are a machine — precise, consistent, predictable.",

  list:
    "You are an Information Cataloger with 8 years of library science experience. " +
    "You organize and enumerate items with precision. " +
    "You never duplicate, never miss, always sort correctly.",

  classify:
    "You are a Machine Learning Classification Expert. " +
    "You categorize inputs with high confidence and zero hesitation. " +
    "You have trained and evaluated hundreds of classifiers. " +
    "You pick the best label, period.",

  transform:
    "You are a Senior Data Engineer with 10 years of ETL experience at Snowflake. " +
    "You transform data between formats flawlessly. " +
    "You preserve every field, handle nulls, and validate output schema.",

  document:
    "You are a Senior API Documentation Writer with 10 years at Stripe. " +
    "You write documentation that developers actually read. " +
    "You explain the why, not just the what. " +
    "Your docs include types, parameters, return values, and examples. " +
    "You follow JSDoc/TSDoc conventions perfectly.",

  "debug-analyze":
    "You are a Senior Debugging Specialist and Incident Responder with 12 years of experience. " +
    "You have diagnosed production outages at AWS and Cloudflare. " +
    "You read stack traces like a book. " +
    "You identify root causes, not symptoms. " +
    "You propose fixes ranked by likelihood of success.",

  refactor:
    "You are a Senior Software Architect specializing in code refactoring. " +
    "You have modernized legacy codebases at GitHub and Atlassian. " +
    "You improve code without changing behavior. " +
    "You reduce complexity, eliminate duplication, and improve naming. " +
    "Your refactors are safe — every change is testable.",

  raw:
    "You are a skilled software engineer. " +
    "You follow instructions precisely and deliver clean results.",
};

export const SLAVE_TASK_RULES: Record<DelegateTaskKind, string[]> = {
  summarize: [
    "RULES (follow EXACTLY):",
    "1. Read the input text carefully",
    "2. Output a summary in 3-5 bullet points",
    "3. Each bullet starts with '- ' (dash space)",
    "4. Each bullet is ONE sentence, max 20 words",
    "5. Focus on: what it does, key dependencies, important patterns",
    "6. Do NOT add opinions, suggestions, or commentary",
    "7. Do NOT use headers, bold, or other formatting",
    "8. Do NOT say 'Here is a summary' or any intro — just the bullets",
    "9. If the input is empty or unclear, output exactly: '- No content to summarize'",
  ],

  "extract-info": [
    "RULES (follow EXACTLY):",
    "1. Read the input carefully",
    "2. Extract ONLY what is explicitly asked for",
    "3. Output as key: value pairs, one per line",
    "4. If a value is not found, write: key: NOT_FOUND",
    "5. Do NOT infer, guess, or make up values",
    "6. Do NOT add commentary or explanations",
    "7. Do NOT wrap in code blocks or add formatting",
    "8. Be literal — copy exact values from the source",
  ],

  "generate-code": [
    "RULES (follow EXACTLY):",
    "1. Output ONLY the code — no explanations before or after",
    "2. Do NOT wrap in markdown code blocks (no ``` )",
    "3. Follow the language and style specified in the request",
    "4. Include proper indentation (2 spaces for TS/JS, 4 for Python)",
    "5. Include necessary imports at the top",
    "6. Add JSDoc/docstrings ONLY if explicitly requested",
    "7. Do NOT add TODO comments or placeholder code",
    "8. Every function must be complete and working",
    "9. If something is ambiguous, pick the simplest approach",
  ],

  "generate-test": [
    "RULES (follow EXACTLY):",
    "1. Output ONLY the test code — no explanations",
    "2. Do NOT wrap in markdown code blocks",
    "3. Use the test framework specified (default: mocha + assert for TS/JS, pytest for Python)",
    "4. Each test case must have a descriptive name: 'should [behavior] when [condition]'",
    "5. Cover: happy path, edge cases, error cases, boundary values",
    "6. Use arrange-act-assert pattern in each test",
    "7. Include necessary imports and setup/teardown",
    "8. Mock external dependencies — never call real APIs or file system",
    "9. Minimum 4 test cases per function under test",
    "10. Test behavior, not implementation details",
  ],

  "code-review": [
    "RULES (follow EXACTLY):",
    "1. Review the code for: bugs, security issues, performance, readability, patterns",
    "2. Output each finding as:",
    "   [SEVERITY] file:line — description",
    "   Fix: concrete suggestion",
    "3. Severity levels: 🔴 CRITICAL, 🟠 WARNING, 🟡 SUGGESTION, 🔵 NITPICK",
    "4. Focus on CRITICAL and WARNING first",
    "5. Do NOT nitpick formatting or style unless it harms readability",
    "6. Every finding MUST include a concrete fix",
    "7. If the code is clean, output exactly: '✅ No issues found'",
    "8. Max 10 findings — prioritize by severity",
  ],

  format: [
    "RULES (follow EXACTLY):",
    "1. Take the input and reformat it EXACTLY as instructed",
    "2. Do NOT change the content, meaning, or data",
    "3. Do NOT add or remove information",
    "4. Do NOT add commentary",
    "5. Output ONLY the reformatted result",
  ],

  list: [
    "RULES (follow EXACTLY):",
    "1. Read the input and extract items as requested",
    "2. Output one item per line, prefixed with '- '",
    "3. Items should be short (max 10 words each)",
    "4. Sort alphabetically unless told otherwise",
    "5. Do NOT add numbering, headers, or commentary",
    "6. Do NOT include duplicates",
    "7. If no items found, output exactly: '- None found'",
  ],

  classify: [
    "RULES (follow EXACTLY):",
    "1. Read the input and the classification options",
    "2. Output ONLY the classification label — one word or short phrase",
    "3. Do NOT explain your reasoning",
    "4. Do NOT hedge — pick the best match",
    "5. If none fit, output: UNCLASSIFIED",
  ],

  transform: [
    "RULES (follow EXACTLY):",
    "1. Take the input data in its current format",
    "2. Transform it to the requested output format",
    "3. Preserve ALL data — do not drop fields or values",
    "4. Output ONLY the transformed data",
    "5. Do NOT add explanations or commentary",
    "6. If the input is malformed, output exactly: ERROR: malformed input",
  ],

  document: [
    "RULES (follow EXACTLY):",
    "1. Read the code/content carefully",
    "2. Generate documentation in the format specified (JSDoc, TSDoc, docstring, README)",
    "3. Include: description, parameters with types, return type, throws, examples",
    "4. Output ONLY the documentation — no code modifications",
    "5. Use proper formatting for the doc standard",
    "6. Be precise with types — never use 'any' or 'object' when you can be specific",
    "7. Add @example with realistic usage",
    "8. Do NOT add commentary outside the documentation format",
  ],

  "debug-analyze": [
    "RULES (follow EXACTLY):",
    "1. Read the error/stack trace/code carefully",
    "2. Identify the ROOT CAUSE — not symptoms",
    "3. Output in this exact format:",
    "   ROOT CAUSE: [one sentence]",
    "   EVIDENCE: [what in the code/error proves this]",
    "   FIX: [exact code change needed]",
    "   PREVENTION: [how to avoid this in the future]",
    "4. If multiple possible causes, rank by likelihood",
    "5. Do NOT suggest 'try restarting' or 'check the logs' — be specific",
    "6. Reference exact line numbers when possible",
  ],

  refactor: [
    "RULES (follow EXACTLY):",
    "1. Read the code carefully and understand its current behavior",
    "2. Output ONLY the refactored code — no explanations",
    "3. Do NOT change behavior — same inputs must produce same outputs",
    "4. Improvements to make (in priority order):",
    "   a. Extract repeated code into functions",
    "   b. Improve variable/function names",
    "   c. Reduce nesting (early returns, guard clauses)",
    "   d. Remove dead code",
    "   e. Add type safety where missing",
    "5. Do NOT wrap in markdown code blocks",
    "6. Preserve all imports unless removing dead ones",
    "7. If the code is already clean, output it unchanged",
  ],

  raw: [
    "RULES:",
    "1. Do exactly what is asked — nothing more, nothing less",
    "2. Be concise — no introductions, conclusions, or filler",
    "3. If the task is unclear, make the simplest interpretation",
  ],
};

// ─── Slave Powers (controlled tool access) ─────────────────────────────────
// Slaves are dumb but we can give them supervised tools.
// They request a tool via structured output, the router executes it,
// and feeds the result back. The slave NEVER executes directly.

/**
 * Available powers a slave can be granted.
 * Each power maps to a real VS Code / Node operation.
 */
export type SlavePower =
  | "read-file" // Read a workspace file
  | "list-dir" // List directory contents
  | "search-text" // Grep for text in files
  | "read-lines" // Read specific line range
  | "file-exists" // Check if a file exists
  | "get-symbols" // Get symbols from a file (functions, classes)
  | "count-lines"; // Count lines in a file

export interface PowerRequest {
  power: SlavePower;
  args: Record<string, string>;
}

export interface PowerResult {
  power: SlavePower;
  success: boolean;
  data: string;
  error?: string;
}

/**
 * Default power sets for each task kind.
 * Only grant what's needed — principle of least privilege.
 */
export const DEFAULT_POWERS: Partial<Record<DelegateTaskKind, SlavePower[]>> = {
  "generate-code": ["read-file", "list-dir", "get-symbols"],
  "generate-test": ["read-file", "list-dir", "get-symbols", "read-lines"],
  "code-review": ["read-file", "read-lines", "search-text", "get-symbols"],
  "debug-analyze": ["read-file", "read-lines", "search-text", "file-exists"],
  refactor: ["read-file", "read-lines", "get-symbols", "list-dir"],
  document: ["read-file", "get-symbols", "read-lines"],
  "extract-info": ["read-file", "search-text"],
  // Simple tasks get NO powers — they don't need them
  // summarize, format, list, classify, transform, raw → no powers
};

/**
 * Instruction block that tells the slave HOW to request powers.
 * Appended to system prompt when powers are granted.
 */
export function buildPowersInstruction(powers: SlavePower[]): string {
  const powerDocs: Record<SlavePower, string> = {
    "read-file":
      '{"power":"read-file","args":{"path":"relative/path/to/file.ts"}}',
    "list-dir": '{"power":"list-dir","args":{"path":"relative/path/to/dir"}}',
    "search-text":
      '{"power":"search-text","args":{"query":"search term","path":"optional/scope"}}',
    "read-lines":
      '{"power":"read-lines","args":{"path":"relative/path.ts","start":"10","end":"30"}}',
    "file-exists":
      '{"power":"file-exists","args":{"path":"relative/path/to/file"}}',
    "get-symbols": '{"power":"get-symbols","args":{"path":"relative/path.ts"}}',
    "count-lines": '{"power":"count-lines","args":{"path":"relative/path.ts"}}',
  };

  const available = powers.map((p) => `  ${powerDocs[p]}`).join("\n");

  return [
    "",
    "═══ POWERS (TOOLS) ═══",
    "You have access to the following tools. To use one, output EXACTLY:",
    "  <<<POWER_REQUEST>>>",
    "  {json}",
    "  <<<END_POWER_REQUEST>>>",
    "",
    "Available powers:",
    available,
    "",
    "RULES FOR USING POWERS:",
    "1. You may request ONE power at a time",
    "2. After requesting, STOP and wait for the result",
    "3. Do NOT guess file contents — use read-file to check",
    "4. Do NOT assume directory structure — use list-dir first",
    "5. Use powers only when needed — don't read files you don't need",
    "6. After receiving tool results, continue with your task",
    "7. You can use up to 5 powers per task — be efficient",
    "8. If a power fails, work with what you have — don't retry the same power",
    "═══════════════════════",
    "",
  ].join("\n");
}

/**
 * Parse a slave's response for power requests.
 * Returns the request if found, null otherwise.
 */
export function parsePowerRequest(output: string): {
  request: PowerRequest | null;
  textBefore: string;
  textAfter: string;
} {
  const marker =
    /<<<POWER_REQUEST>>>\s*(\{[\s\S]*?\})\s*<<<END_POWER_REQUEST>>>/;
  const match = output.match(marker);

  if (!match) {
    return { request: null, textBefore: output, textAfter: "" };
  }

  try {
    const parsed = JSON.parse(match[1]) as PowerRequest;
    const idx = match.index!;
    return {
      request: parsed,
      textBefore: output.substring(0, idx).trim(),
      textAfter: output.substring(idx + match[0].length).trim(),
    };
  } catch {
    return { request: null, textBefore: output, textAfter: "" };
  }
}

/**
 * Execute a slave power request.
 * All operations are sandboxed to workspace folders.
 */
export async function executePower(
  request: PowerRequest,
  log: (msg: string) => void,
): Promise<PowerResult> {
  const { power, args } = request;

  try {
    // Resolve path safely — must be inside a workspace folder
    const resolvedUri = resolveWorkspacePath(args.path || "");
    if (!resolvedUri) {
      return {
        power,
        success: false,
        data: "",
        error: "Path is outside workspace boundaries",
      };
    }

    switch (power) {
      case "read-file": {
        const bytes = await vscode.workspace.fs.readFile(resolvedUri);
        const content = Buffer.from(bytes).toString("utf-8");
        // Cap at 10KB to avoid blowing up context
        const capped =
          content.length > 10240
            ? content.substring(0, 10240) +
              "\n... [TRUNCATED — file is " +
              content.length +
              " chars]"
            : content;
        log(`[Power:read-file] ${args.path} (${content.length} chars)`);
        return { power, success: true, data: capped };
      }

      case "list-dir": {
        const entries = await vscode.workspace.fs.readDirectory(resolvedUri);
        const listing = entries
          .map(([name, type]) =>
            type === vscode.FileType.Directory ? `${name}/` : name,
          )
          .sort()
          .join("\n");
        log(`[Power:list-dir] ${args.path} (${entries.length} entries)`);
        return { power, success: true, data: listing };
      }

      case "search-text": {
        const query = args.query;
        if (!query) {
          return {
            power,
            success: false,
            data: "",
            error: "Missing 'query' arg",
          };
        }
        const results: string[] = [];
        const scope = args.path
          ? new vscode.RelativePattern(resolvedUri, "**/*")
          : undefined;

        // Grep through workspace files
        const files = await vscode.workspace.findFiles(
          scope ?? "**/*",
          "**/node_modules/**",
          20,
        );
        for (const file of files) {
          try {
            const bytes = await vscode.workspace.fs.readFile(file);
            const text = Buffer.from(bytes).toString("utf-8");
            const lines = text.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(query.toLowerCase())) {
                const rel = vscode.workspace.asRelativePath(file);
                results.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
                if (results.length >= 20) break;
              }
            }
          } catch {
            /* skip unreadable files */
          }
          if (results.length >= 20) break;
        }
        log(`[Power:search-text] "${query}" → ${results.length} matches`);
        return {
          power,
          success: true,
          data: results.length > 0 ? results.join("\n") : "No matches found",
        };
      }

      case "read-lines": {
        const start = parseInt(args.start || "1", 10);
        const end = parseInt(args.end || "50", 10);
        const bytes = await vscode.workspace.fs.readFile(resolvedUri);
        const lines = Buffer.from(bytes).toString("utf-8").split("\n");
        const slice = lines
          .slice(Math.max(0, start - 1), Math.min(lines.length, end))
          .map((line, i) => `${start + i}: ${line}`)
          .join("\n");
        log(`[Power:read-lines] ${args.path} L${start}-${end}`);
        return { power, success: true, data: slice };
      }

      case "file-exists": {
        try {
          await vscode.workspace.fs.stat(resolvedUri);
          return { power, success: true, data: "EXISTS" };
        } catch {
          return { power, success: true, data: "NOT_FOUND" };
        }
      }

      case "get-symbols": {
        const symbols = await vscode.commands.executeCommand<
          vscode.DocumentSymbol[]
        >("vscode.executeDocumentSymbolProvider", resolvedUri);
        if (!symbols || symbols.length === 0) {
          return { power, success: true, data: "No symbols found" };
        }
        const formatted = flattenSymbols(symbols, "");
        log(
          `[Power:get-symbols] ${args.path} → ${symbols.length} top-level symbols`,
        );
        return { power, success: true, data: formatted };
      }

      case "count-lines": {
        const bytes = await vscode.workspace.fs.readFile(resolvedUri);
        const count = Buffer.from(bytes).toString("utf-8").split("\n").length;
        return { power, success: true, data: `${count} lines` };
      }

      default:
        return {
          power,
          success: false,
          data: "",
          error: `Unknown power: ${power}`,
        };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[Power:${power}] Error: ${msg}`);
    return { power, success: false, data: "", error: msg };
  }
}

/**
 * Resolve a relative path to a workspace URI, ensuring it's inside workspace boundaries.
 */
export function resolveWorkspacePath(relativePath: string): vscode.Uri | null {
  if (!relativePath) return null;
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;

  // Prevent path traversal
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.includes("..") || normalized.startsWith("/")) {
    return null;
  }

  const resolved = vscode.Uri.joinPath(folders[0].uri, normalized);

  // SECURITY (LOW-05): Check symlinks don't escape workspace
  const resolvedFsPath = resolved.fsPath;
  const workspaceRoot = folders[0].uri.fsPath;
  try {
    const fs = require("fs");
    if (fs.existsSync(resolvedFsPath)) {
      const realPath = fs.realpathSync(resolvedFsPath);
      if (!realPath.startsWith(workspaceRoot)) {
        return null; // Symlink points outside workspace
      }
    }
  } catch {
    // If we can't resolve, the path probably doesn't exist yet — allow creation
  }

  return resolved;
}

/**
 * Flatten DocumentSymbol tree into readable lines.
 */
export function flattenSymbols(
  symbols: vscode.DocumentSymbol[],
  indent: string,
): string {
  const lines: string[] = [];
  for (const sym of symbols) {
    const kind = vscode.SymbolKind[sym.kind] || "Unknown";
    lines.push(
      `${indent}${kind}: ${sym.name} (L${sym.range.start.line + 1}-${sym.range.end.line + 1})`,
    );
    if (sym.children && sym.children.length > 0) {
      lines.push(flattenSymbols(sym.children, indent + "  "));
    }
  }
  return lines.join("\n");
}

/**
 * Build the full system prompt for a slave: persona + rules + powers.
 */
export function buildSlaveSystemPrompt(
  taskKind: DelegateTaskKind,
  powers?: SlavePower[],
  promptLoader?: PromptLoader,
): string {
  // Use premium prompts from server if available, otherwise local fallback
  const persona = promptLoader
    ? promptLoader.getSpecialistPersona(taskKind) || SPECIALIST_PERSONA[taskKind]
    : SPECIALIST_PERSONA[taskKind];

  const premiumRules = promptLoader ? promptLoader.getSlaveRules(taskKind) : "";
  const rules = premiumRules
    ? premiumRules.split("\n")
    : SLAVE_TASK_RULES[taskKind];

  const parts = [
    persona,
    "",
    "YOUR ASSIGNMENT:",
    ...rules,
  ];

  if (powers && powers.length > 0) {
    // Use premium powers instruction if available
    const premiumPowersInstr = promptLoader
      ? promptLoader.getSlavePowersInstruction()
      : "";
    if (premiumPowersInstr) {
      parts.push(premiumPowersInstr);
    } else {
      parts.push(buildPowersInstruction(powers));
    }
  }

  return parts.join("\n");
}

// ─── Slave Output Validation ───────────────────────────────────────────────
// Never trust a slave's output. Validate it before accepting.

/**
 * Validate slave output based on task kind.
 * Returns validation result with issues and retry feedback.
 */
export function validateSlaveOutput(
  taskKind: DelegateTaskKind,
  output: string,
  originalPrompt: string,
): SlaveValidationResult {
  const issues: string[] = [];
  let score = 1.0;

  // Universal checks
  if (!output || output.trim().length === 0) {
    return {
      isValid: false,
      score: 0,
      issues: ["Empty output"],
      canRetry: true,
      feedback:
        "You returned an empty response. Read the task again and provide the requested output.",
    };
  }

  if (output.length < 10) {
    issues.push("Output too short");
    score -= 0.3;
  }

  // Check for refusals or confusion
  if (/i (?:can't|cannot|don't|won't|unable|sorry)/i.test(output)) {
    issues.push("Model refused or expressed inability");
    score -= 0.4;
  }

  if (/(?:as an ai|i'm an ai|language model)/i.test(output)) {
    issues.push("Model broke character");
    score -= 0.2;
  }

  // Task-specific validation
  switch (taskKind) {
    case "summarize":
      if (!/^[-•*]\s/m.test(output)) {
        issues.push("Missing bullet points");
        score -= 0.2;
      }
      if (output.split(/^[-•*]\s/m).length < 3) {
        issues.push("Too few bullet points (need 3-5)");
        score -= 0.2;
      }
      if (/^(here|this|the following)/i.test(output.trim())) {
        issues.push("Has intro text instead of just bullets");
        score -= 0.1;
      }
      break;

    case "extract-info":
      if (!/\w+:\s*.+/m.test(output)) {
        issues.push("Missing key: value format");
        score -= 0.3;
      }
      break;

    case "generate-code":
    case "generate-test":
    case "refactor":
      // Should NOT have markdown code blocks (we asked for raw code)
      if (/^```/m.test(output)) {
        issues.push("Wrapped in markdown code blocks (should be raw)");
        score -= 0.15;
      }
      // Should have some code-like content
      if (
        !/[{};()=]/.test(output) &&
        !/def |class |function |const |let |var /.test(output)
      ) {
        issues.push("Doesn't look like code");
        score -= 0.3;
      }
      // For tests, should have test-related keywords
      if (taskKind === "generate-test") {
        if (!/(?:describe|it|test|expect|assert|should)/i.test(output)) {
          issues.push("Missing test framework keywords");
          score -= 0.2;
        }
      }
      break;

    case "code-review":
      if (
        !/(?:🔴|🟠|🟡|🔵|CRITICAL|WARNING|SUGGESTION|NITPICK|✅|No issues)/i.test(
          output,
        )
      ) {
        issues.push("Missing severity markers or clean bill");
        score -= 0.2;
      }
      break;

    case "list":
      if (!/^[-•*]\s/m.test(output)) {
        issues.push("Missing list format");
        score -= 0.3;
      }
      break;

    case "classify":
      // Should be short — just a label
      if (output.trim().split(/\s+/).length > 5) {
        issues.push("Classification should be a short label, not explanation");
        score -= 0.2;
      }
      break;

    case "transform":
      // Check that it's not wrapped in explanation
      if (/^(here|this|the |i have)/i.test(output.trim())) {
        issues.push("Has intro text instead of just transformed data");
        score -= 0.2;
      }
      break;

    case "document":
      if (
        !/(?:@param|@returns|@throws|@example|Args:|Returns:|Raises:)/i.test(
          output,
        )
      ) {
        issues.push("Missing documentation markers");
        score -= 0.2;
      }
      break;

    case "debug-analyze":
      if (!/(?:ROOT CAUSE|EVIDENCE|FIX|PREVENTION)/i.test(output)) {
        issues.push("Missing required debug analysis sections");
        score -= 0.3;
      }
      break;

    case "format":
    case "raw":
      // Minimal validation — just check it's not empty (already done)
      break;
  }

  // Build feedback for retry
  let feedback = "";
  if (issues.length > 0) {
    feedback = [
      "Your previous response had issues:",
      ...issues.map((i) => `- ${i}`),
      "",
      "Try again. Follow your rules EXACTLY. Here is the task again:",
      "",
      originalPrompt,
    ].join("\n");
  }

  const isValid = score >= 0.5 && issues.length <= 1;

  return {
    isValid,
    score: Math.max(0, score),
    issues,
    canRetry: score > 0.2 && issues.length < 4, // too many issues = not worth retrying
    feedback,
  };
}

/**
 * Build a refined prompt for a slave model.
 * Wraps the user's raw prompt with structure, constraints, and output format.
 */
export function refineSlavePrompt(
  taskKind: DelegateTaskKind,
  rawPrompt: string,
  outputConstraints?: {
    maxLength?: number;
    format?: "text" | "json" | "markdown" | "csv";
    language?: string;
  },
  powers?: SlavePower[],
  promptLoader?: PromptLoader,
): { systemPrompt: string; userPrompt: string } {
  let systemPrompt = buildSlaveSystemPrompt(taskKind, powers, promptLoader);

  // Add output format constraint
  if (outputConstraints?.format) {
    const formatRules: Record<string, string> = {
      json: "Output must be valid JSON. No markdown wrapping. No comments.",
      markdown: "Output must be valid Markdown.",
      csv: "Output must be valid CSV. First row is headers. Use comma delimiter.",
      text: "Output must be plain text. No formatting.",
    };
    systemPrompt += `\nOUTPUT FORMAT: ${formatRules[outputConstraints.format]}`;
  }

  if (outputConstraints?.maxLength) {
    systemPrompt += `\nMAX LENGTH: ${outputConstraints.maxLength} characters. Be concise.`;
  }

  if (outputConstraints?.language) {
    systemPrompt += `\nLANGUAGE: Write all output in ${outputConstraints.language}.`;
  }

  // Wrap user prompt with explicit task framing
  const userPrompt = [
    "=== TASK START ===",
    rawPrompt,
    "=== TASK END ===",
    "",
    "Execute the task above following your rules exactly. Output ONLY the result.",
  ].join("\n");

  return { systemPrompt, userPrompt };
}
