/**
 * LM Tools for Agent Diary — read/write per-mode learning journals.
 *
 * Sub-tools registered in toolbox:
 * - readAgentDiary(mode) — read the last N entries from an agent's diary
 * - writeAgentDiary(mode, entry) — append a new entry to an agent's diary
 */

import * as vscode from "vscode";
import { readFullDiary, appendToDiary } from "./agent-diary";
import type { DiaryEntry } from "./agent-diary";

// ——— ReadAgentDiary ————————————————————————————————————————————————

export interface ReadAgentDiaryInput {
  mode: string;
}

export class ReadAgentDiaryTool
  implements vscode.LanguageModelTool<ReadAgentDiaryInput>
{
  constructor(
    private memoryPath: string,
    private log: (msg: string) => void,
  ) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ReadAgentDiaryInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { mode } = options.input;
    this.log(`[LM Tool] readAgentDiary: mode="${mode}"`);

    const content = readFullDiary(this.memoryPath, mode);
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(content),
    ]);
  }
}

// ——— WriteAgentDiary ———————————————————————————————————————————————

export interface WriteAgentDiaryInput {
  mode: string;
  title: string;
  context?: string;
  learning: string;
  confidence?: "high" | "medium" | "low";
}

export class WriteAgentDiaryTool
  implements vscode.LanguageModelTool<WriteAgentDiaryInput>
{
  constructor(
    private memoryPath: string,
    private log: (msg: string) => void,
  ) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<WriteAgentDiaryInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { mode, title, context, learning, confidence } = options.input;
    this.log(`[LM Tool] writeAgentDiary: mode="${mode}", title="${title}"`);

    const entry: DiaryEntry = {
      date: new Date().toISOString().split("T")[0],
      title,
      context: context || "Agent session",
      learning,
      confidence: confidence || "medium",
    };

    const success = appendToDiary(this.memoryPath, mode, entry);

    const msg = success
      ? `✅ Diary entry added for ${mode}: "${title}"`
      : `❌ Failed to write diary for "${mode}". Valid modes: documenter, reviewer, planner, researcher, onboard.`;

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(msg),
    ]);
  }
}
