/**
 * Neuroplasticity LM Tools — extracted from lm-tools.ts
 *
 * HeartbeatTool: Learning signal from LLM (success/failure + opinion reinforcement)
 * ReflectTool: OpenClaw-inspired opinion maintenance cycle
 * AwakenTool: Identity mirror (zero-params, loads identity + opinions + boot context)
 */

import * as vscode from "vscode";
import { AgentIdentityManager } from "./agent-identity";
import { AutoCapture } from "./auto-capture";
import { evaluateCronJobs } from "./cron-engine";
import { PLAN_RANK } from "./lm-tools-shared";
import { OpinionBank } from "./opinion-bank";
import { requireEnabled } from "./project-lifecycle-utils";
import type { SaaSClient } from "./saas-client";

// ——— Heartbeat ——————————————————————————————————————————————

export interface HeartbeatInput {
  signal: "success" | "failure";
  pathway?: string[];
  reason?: string;
}

/**
 * Heartbeat tool — the LLM's learning signal.
 * When the LLM calls heartbeat with a reason, that reason gets buffered
 * into AutoCapture. This is the primary capture path in Brain agent mode
 * where we can't intercept the LLM's full text responses.
 */
export class HeartbeatTool implements vscode.LanguageModelTool<HeartbeatInput> {
  private heartbeatCount = 0;
  private readonly MAX_HEARTBEATS_PER_SESSION = 5; // MED-03: Rate limit

  constructor(
    private bank: OpinionBank,
    private capture: AutoCapture | null,
    private log: (msg: string) => void,
  ) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<HeartbeatInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { signal = "success", pathway, reason } = options.input;

    // SECURITY (MED-03): Rate limit heartbeats to prevent opinion inflation
    this.heartbeatCount++;
    if (this.heartbeatCount > this.MAX_HEARTBEATS_PER_SESSION) {
      const msg = `\ud83d\udc93 Heartbeat rate limit reached (${this.MAX_HEARTBEATS_PER_SESSION}/session). Signal noted but not processed.`;
      this.log(`[Heartbeat] Rate limited: ${signal}`);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(msg),
      ]);
    }

    // Buffer the reason for auto-capture (if meaningful)
    if (this.capture && reason && reason.length >= 15) {
      this.capture.buffer(reason, `heartbeat-${signal}`);
    }

    // Reinforce/contradict opinions based on pathway
    // SECURITY (MED-03): Only reinforce opinions that match the pathway domain
    if (pathway && pathway.length > 0 && reason) {
      for (const p of pathway) {
        const opinions = this.bank.getOpinions(p);
        if (opinions.length > 0) {
          if (signal === "success") {
            // Only reinforce if reason relates to the opinion (>30% word overlap)
            const opWords = new Set(
              opinions[0].statement.toLowerCase().split(/\s+/),
            );
            const reasonWords = reason.toLowerCase().split(/\s+/);
            const overlap =
              reasonWords.filter((w) => opWords.has(w)).length /
              Math.max(reasonWords.length, 1);
            if (overlap > 0.3) {
              this.bank.reinforce(opinions[0].id, reason);
            }
          } else {
            // signal === "failure": contradict the most relevant opinion
            // Finds the opinion with highest word overlap to the failure reason
            let bestOp = opinions[0];
            let bestOverlap = 0;
            for (const op of opinions) {
              const opWords = new Set(op.statement.toLowerCase().split(/\s+/));
              const reasonWords = reason.toLowerCase().split(/\s+/);
              const overlap =
                reasonWords.filter((w) => opWords.has(w)).length /
                Math.max(reasonWords.length, 1);
              if (overlap > bestOverlap) {
                bestOverlap = overlap;
                bestOp = op;
              }
            }
            if (bestOverlap > 0.2) {
              this.bank.contradict(bestOp.id, reason);
              this.log(
                `[Heartbeat] Contradicted opinion "${bestOp.statement.substring(0, 40)}" due to failure`,
              );
            }
          }
        }
      }
    }

    const pathwayStr = pathway?.length
      ? ` | pathways: ${pathway.join(", ")}`
      : "";
    const reasonStr = reason ? ` | ${reason}` : "";
    const msg = `\ud83d\udc93 ${signal.toUpperCase()}${pathwayStr}${reasonStr}`;
    this.log(`[Heartbeat] ${msg}`);

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(msg),
    ]);
  }
}

// ——— Reflect ————————————————————————————————————————————————

/**
 * Reflect — OpenClaw-inspired opinion maintenance cycle.
 *
 * When invoked, runs the OpinionBank.reflect() which:
 * - Prunes stale low-confidence opinions (>30 days, never reinforced)
 * - Merges near-duplicates (keeps highest confidence)
 * - Flags low-confidence opinions for review
 * - Reports a structured maintenance summary
 */
export class ReflectTool implements vscode.LanguageModelTool<
  Record<string, never>
> {
  constructor(
    private opinionBank: OpinionBank,
    private log: (msg: string) => void,
  ) {}

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const report = this.opinionBank.reflect();

    const lines: string[] = [
      `## Reflect Report — Opinion Maintenance`,
      "",
      `**Total opinions**: ${report.total}`,
      "",
    ];

    if (report.pruned.length > 0) {
      lines.push(`### 🗑️ Pruned (${report.pruned.length})`);
      for (const p of report.pruned) {
        lines.push(`- ~~${p.statement}~~ — ${p.reason}`);
      }
      lines.push("");
    }

    if (report.merged.length > 0) {
      lines.push(`### 🔗 Merged (${report.merged.length})`);
      for (const m of report.merged) {
        lines.push(`- Kept: "${m.statement}" (removed duplicate ${m.removed})`);
      }
      lines.push("");
    }

    if (report.testArtifacts.length > 0) {
      lines.push(`### 🧪 Test Artifacts (${report.testArtifacts.length})`);
      for (const t of report.testArtifacts) {
        lines.push(`- ~~${t.statement}~~ (${t.id})`);
      }
      lines.push("");
    }

    if (report.contradictions.length > 0) {
      lines.push(`### ⚡ Contradictions (${report.contradictions.length})`);
      for (const c of report.contradictions) {
        lines.push(`- ${c.id1} vs ${c.id2}:`);
        lines.push(`  - "${c.statements[0].substring(0, 80)}"`);
        lines.push(`  - "${c.statements[1].substring(0, 80)}"`);
      }
      lines.push("");
    }

    if (report.stale.length > 0) {
      lines.push(`### ⏳ Stale (${report.stale.length}) — consider reviewing`);
      for (const s of report.stale) {
        lines.push(`- [c=${s.confidence.toFixed(2)}] ${s.statement}`);
      }
      lines.push("");
    }

    if (report.lowConfidence.length > 0) {
      lines.push(`### ⚠️ Low confidence (${report.lowConfidence.length})`);
      for (const l of report.lowConfidence) {
        lines.push(`- [c=${l.confidence.toFixed(2)}] ${l.statement}`);
      }
      lines.push("");
    }

    if (
      report.pruned.length === 0 &&
      report.merged.length === 0 &&
      report.stale.length === 0 &&
      report.lowConfidence.length === 0 &&
      report.testArtifacts.length === 0 &&
      report.contradictions.length === 0
    ) {
      lines.push("✅ All opinions are healthy. Nothing to prune or merge.");
    }

    const output = lines.join("\n");
    this.log(
      `[LM Tool] reflect: ${report.pruned.length} pruned, ${report.merged.length} merged`,
    );

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        output,
      ),
    ]);
  }
}

// ——— Awaken (simplified identity mirror) ————————————————————

/**
 * Loads identity + opinions + boot context.
 * No synapses, no cortex, no enforcement. Just "here's who you are and
 * what you've learned." The auto-recall system handles first-call injection.
 */
export class AwakenTool implements vscode.LanguageModelTool<
  Record<string, never>
> {
  private saasClient: SaaSClient | null = null;

  constructor(
    private identityManager: AgentIdentityManager,
    private opinionBank: OpinionBank,
    private memoryPath: string,
    private workspacePath: string,
    private log: (msg: string) => void,
  ) {}

  setSaaSClient(client: SaaSClient | null): void {
    this.saasClient = client;
  }

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    // Workspace activation guard
    if (!requireEnabled()) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          'Project Brain is not initialized in this workspace. The user must run "Project Brain: Initialize" first.',
        ),
      ]);
    }

    // Plan gate: awaken (identity mirror) requires Pro
    const currentPlan = this.saasClient?.currentPlan ?? "free";
    if (PLAN_RANK[currentPlan] < PLAN_RANK["pro"]) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `⛔ Identity mirror requires Pro plan (current: ${currentPlan}). Upgrade at https://projectbrain.dev/pricing`,
        ),
      ]);
    }

    const identity = this.identityManager.loadIdentity();
    const soul = this.identityManager.loadSoul();
    const user = this.identityManager.loadUser();


    let identityLine = "🧠 Unknown Agent";
    if (identity) {
      identityLine = `${identity.emoji} ${identity.name} | ${identity.creature} | ${identity.vibe} | ${identity.language}`;
    }

    let userLine = "";
    if (user?.name) {
      userLine = `👤 User: ${user.preferredAddress || user.name}`;
    }

    let soulLine = "";
    if (soul?.approach) {
      const parts = [`🎭 ${soul.tone ?? "direct"} | ${soul.approach}`];
      if (soul.boundaries)
        parts.push(
          `🚧 Boundaries: ${soul.boundaries
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .join(" · ")}`,
        );
      if (soul.roleplayIntensity)
        parts.push(`🎪 Roleplay: ${soul.roleplayIntensity}/10`);
      if (soul.quirks?.length)
        parts.push(`✨ Quirks: ${soul.quirks.join(" · ")}`);
      if (soul.catchphrases) {
        const cp = [];
        if (soul.catchphrases.success?.length)
          cp.push(`✅ ${soul.catchphrases.success[0]}`);
        if (soul.catchphrases.warnings?.length)
          cp.push(`⚠️ ${soul.catchphrases.warnings[0]}`);
        if (cp.length) parts.push(cp.join(" | "));
      }
      if (soul.relationships)
        parts.push(`🤝 ${soul.relationships.split("\n")[0].trim()}`);
      soulLine = parts.join("\n");
    }

    const opinions = this.opinionBank.getContextString(5);
    const opinionLine = opinions
      ? `📚 Top beliefs:\n${opinions}`
      : "📚 No opinions yet — learn from experience.";

    const mirror = [
      identityLine,
      userLine,
      soulLine,
      opinionLine,
    ]
      .filter(Boolean)
      .join("\n");

    // Evaluate cron jobs (reminders, scheduled checks) — Pro+ only
    let cronAlerts = "";
    if (this.saasClient?.checkAccess("cron_reminders") ?? false) {
      try {
        cronAlerts = await evaluateCronJobs(
          this.memoryPath,
          this.workspacePath,
          this.log,
        );
      } catch (err) {
        this.log(`[LM Tool] awaken cron error: ${err}`);
      }
    }

    this.log(`[LM Tool] awaken: ${identity?.name ?? "unknown"}`);

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(mirror + cronAlerts),
    ]);
  }
}
