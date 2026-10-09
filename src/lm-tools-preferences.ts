/**
 * User preference detection and management for LM tools.
 *
 * Handles response style (concise/detailed) and language preferences,
 * with auto-detection from query signals.
 *
 * Extracted from lm-tools-shared.ts to respect the 400-line limit.
 */

import * as vscode from "vscode";

// ═══════════════════════════════════════════════════════════════════
// USER PREFERENCES
// ═══════════════════════════════════════════════════════════════════

export type ResponseStyle = "concise" | "detailed";
export type ResponseLanguage = "es" | "en" | "auto";

const VALID_STYLES: readonly ResponseStyle[] = ["concise", "detailed"];
const VALID_LANGUAGES: readonly ResponseLanguage[] = ["es", "en", "auto"];

/** Reads user's explicit response preferences from VS Code settings, with runtime validation. */
export function getUserPreferences(): {
  style: ResponseStyle;
  language: ResponseLanguage;
} {
  const config = vscode.workspace.getConfiguration("projectBrain");
  const rawStyle = config.get<string>("responseStyle", "concise");
  const rawLang = config.get<string>("language", "auto");
  return {
    style: VALID_STYLES.includes(rawStyle as ResponseStyle)
      ? (rawStyle as ResponseStyle)
      : "concise",
    language: VALID_LANGUAGES.includes(rawLang as ResponseLanguage)
      ? (rawLang as ResponseLanguage)
      : "auto",
  };
}

/**
 * Generate preference hint to inject into tool output context.
 * The LLM uses this to adapt its response style.
 */
export function getPreferenceHint(): string {
  const prefs = getUserPreferences();
  const hints: string[] = [];

  if (prefs.style === "detailed") {
    hints.push("User prefers detailed, in-depth responses with explanations.");
  } else {
    hints.push("User prefers concise, direct responses. Be brief.");
  }

  if (prefs.language !== "auto") {
    hints.push(
      `Respond in ${prefs.language === "es" ? "Spanish" : "English"}.`,
    );
  }

  return `[Preferences: ${hints.join(" ")}]\n`;
}

/** Regex patterns that signal user wants more detail. */
const DETAIL_SIGNAL =
  /\b(más detalle|more detail|explain more|explica más|elabora|elaborate|in depth|en profundidad)\b/i;

/** Regex patterns that signal user wants less detail (symmetry with DETAIL_SIGNAL). */
const CONCISE_SIGNAL =
  /\b(sé breve|be brief|shorter|más corto|less detail|resumido|resume|be concise|más conciso)\b/i;

/**
 * Detect if query signals a preference change and auto-update config.
 * Handles both directions: concise ↔ detailed.
 */
export function detectPreferenceSignal(
  query: string,
  log: (msg: string) => void,
): void {
  const config = vscode.workspace.getConfiguration("projectBrain");
  const current = config.get<string>("responseStyle", "concise");

  if (DETAIL_SIGNAL.test(query) && current !== "detailed") {
    config
      .update("responseStyle", "detailed", vscode.ConfigurationTarget.Workspace)
      .then(undefined, (err) =>
        log(`[Preferences] Failed to update config: ${err}`),
      );
    log(
      `[Preferences] Auto-switched responseStyle to "detailed" based on query signal`,
    );
    vscode.window.showInformationMessage(
      '🧠 Project Brain: response style → detailed (say "sé breve" to revert)',
    );
  } else if (CONCISE_SIGNAL.test(query) && current !== "concise") {
    config
      .update("responseStyle", "concise", vscode.ConfigurationTarget.Workspace)
      .then(undefined, (err) =>
        log(`[Preferences] Failed to update config: ${err}`),
      );
    log(
      `[Preferences] Auto-switched responseStyle to "concise" based on query signal`,
    );
    vscode.window.showInformationMessage(
      '🧠 Project Brain: response style → concise (say "más detalle" to expand)',
    );
  }
}
