import * as vscode from "vscode";
import {
  type ApiValidateResponse,
  GENUINE_KEYWORDS,
  LM_CLASSIFY_PROMPT,
  MECHANICAL_PATTERNS,
  type ValidationResult,
  httpGet,
  httpPost,
} from "./reflection-validator-shared";

/**
 * ReflectionValidator — BERT-powered classifier for auto-captures
 *
 * Validates captured text as "genuine" (thoughtful) vs "mechanical" (autopilot).
 * Only opinions with genuine_score > threshold get saved to OpinionBank.
 *
 * Modes (priority order):
 * 1. HTTP API — calls remote VPS endpoint (fast, no local deps)
 * 2. Heuristic — local keyword/pattern classifier (zero cost, zero credits)
 * 3. VS Code LM — uses Copilot models (opt-in only, costs credits)
 * 4. Fail-open — passes all captures when nothing available
 *
 * Configure via:
 *   projectBrain.reflectionApiUrl  = "http://your-vps:8790"
 *   projectBrain.reflectionApiKey  = "pb-your-api-key"
 */
export class ReflectionValidator {
  private log: (msg: string) => void;
  private threshold: number;
  private apiUrl: string | undefined;
  private apiKey: string;
  private isApiReachable: boolean = false;
  private healthCheckDone: boolean = false;
  private healthCheckPromise: Promise<void> | null = null;
  private lmModel: vscode.LanguageModelChat | null = null;
  private lmChecked: boolean = false;
  private useLmFallback: boolean = false;

  constructor(
    _extensionPath: string,
    log: (msg: string) => void,
    threshold: number = 0.85,
  ) {
    this.log = log;
    this.threshold = threshold;

    const config = vscode.workspace.getConfiguration("projectBrain");
    this.apiUrl = config.get<string>("reflectionApiUrl");
    this.apiKey = config.get<string>("reflectionApiKey", "pb-reflection-2026");
    this.useLmFallback = config.get<boolean>("reflectionUseLmFallback", false);

    if (this.apiUrl) {
      this.log(`[BERT] HTTP mode — API: ${this.apiUrl}`);
      this.healthCheckPromise = this.checkApiHealth();
    } else {
      this.log("[BERT] No API configured — auto-captures bypass validation");
    }
  }

  // ─── API Health ─────────────────────────────────────────────────────

  private async checkApiHealth(): Promise<void> {
    if (!this.apiUrl) return;
    try {
      const res = await httpGet(`${this.apiUrl}/health`, this.apiKey);
      const data = JSON.parse(res);
      this.isApiReachable = data.status === "ok" && data.model_loaded;
      this.log(
        `[BERT] API health: ${this.isApiReachable ? "✓ OK" : "✗ model not loaded"}`,
      );
    } catch (err) {
      this.isApiReachable = false;
      this.log(`[BERT] API unreachable: ${err}`);
    }
    this.healthCheckDone = true;
  }

  // ─── Core Validation ───────────────────────────────────────────────

  async validate(text: string): Promise<ValidationResult> {
    // Wait for health check if still pending
    if (this.healthCheckPromise && !this.healthCheckDone) {
      await this.healthCheckPromise;
    }

    // HTTP API mode (priority 1)
    if (this.apiUrl && this.isApiReachable) {
      return this.validateViaApi(text);
    }

    // Heuristic mode (priority 2) — zero cost, always available
    const heuristic = this.validateViaHeuristic(text);
    if (!heuristic.isGenuine) {
      return heuristic; // Confidently mechanical — reject early
    }

    // VS Code LM mode (priority 3) — opt-in only, costs credits
    if (this.useLmFallback) {
      return this.validateViaLm(text);
    }

    // Return heuristic result (genuine pass-through)
    return heuristic;
  }

  private async validateViaApi(text: string): Promise<ValidationResult> {
    try {
      const body = JSON.stringify({
        text,
        threshold: this.threshold,
      });

      const res = await httpPost(`${this.apiUrl}/validate`, body, this.apiKey);
      const data: ApiValidateResponse = JSON.parse(res);

      this.log(
        `[BERT] ${data.is_genuine ? "✓ GENUINE" : "✗ MECHANICAL"} ` +
          `(score: ${data.genuine_score.toFixed(3)}, ${data.latency_ms}ms)`,
      );

      return {
        isGenuine: data.is_genuine,
        score: data.genuine_score,
      };
    } catch (err) {
      this.log(`[BERT] API error: ${err} — defaulting to PASS`);
      return { isGenuine: true, score: 1.0 };
    }
  }

  // ─── Heuristic Validation (zero-cost) ──────────────────────────────

  private validateViaHeuristic(text: string): ValidationResult {
    const lower = text.toLowerCase();
    const words = lower.split(/\s+/).filter((w) => w.length > 2);

    // Too short = likely mechanical
    if (words.length < 5) {
      return { isGenuine: false, score: 0.1 };
    }

    // Check for mechanical patterns first
    const isMechanical = MECHANICAL_PATTERNS.some((p) => p.test(text.trim()));
    if (isMechanical) {
      return { isGenuine: false, score: 0.1 };
    }

    // Count insight keywords
    let insightHits = 0;
    for (const kw of GENUINE_KEYWORDS) {
      if (lower.includes(kw)) insightHits++;
    }

    // Score: base 0.5 + keyword bonus + length bonus
    let score = 0.5;
    score += Math.min(insightHits * 0.15, 0.4); // up to +0.4 for keywords
    if (words.length > 12) score += 0.1; // longer = more likely genuine

    score = Math.max(0, Math.min(1, score));

    const isGenuine = score >= this.threshold;
    this.log(
      `[BERT/Heuristic] ${isGenuine ? "✓ GENUINE" : "✗ MECHANICAL"} ` +
        `(score: ${score.toFixed(3)}, keywords: ${insightHits})`,
    );
    return { isGenuine, score };
  }

  // ─── VS Code LM Validation (opt-in, costs credits) ─────────────────

  private async ensureLmModel(): Promise<vscode.LanguageModelChat | null> {
    if (this.lmChecked) return this.lmModel;
    this.lmChecked = true;

    try {
      let models = await vscode.lm.selectChatModels({
        vendor: "copilot",
        family: "gpt-4o-mini",
      });
      if (!models.length) {
        models = await vscode.lm.selectChatModels({ vendor: "copilot" });
      }
      if (models.length) {
        this.lmModel = models[0];
        this.log(`[BERT] LM fallback ready: ${models[0].name}`);
      } else {
        this.log("[BERT] No LM models available — fail-open");
      }
    } catch (err) {
      this.log(`[BERT] LM model selection failed: ${err}`);
    }
    return this.lmModel;
  }

  private async validateViaLm(text: string): Promise<ValidationResult> {
    const model = await this.ensureLmModel();
    if (!model) return { isGenuine: true, score: 1.0 };

    try {
      const messages = [
        vscode.LanguageModelChatMessage.User(
          `${LM_CLASSIFY_PROMPT}\n\n"${text}"`,
        ),
      ];

      const response = await model.sendRequest(messages, {
        justification: "Reflection quality gate for auto-captured opinions",
      });

      let responseText = "";
      for await (const chunk of response.text) {
        responseText += chunk;
      }

      const parsed = this.parseLmResponse(responseText);
      this.log(
        `[BERT/LM] ${parsed.isGenuine ? "✓ GENUINE" : "✗ MECHANICAL"} ` +
          `(score: ${parsed.score.toFixed(3)})`,
      );
      return parsed;
    } catch (err) {
      this.log(`[BERT/LM] Classification error: ${err} — defaulting to PASS`);
      return { isGenuine: true, score: 1.0 };
    }
  }

  private parseLmResponse(raw: string): ValidationResult {
    try {
      // Extract JSON from response (may have markdown fences)
      const jsonMatch = raw.match(/\{[^}]+\}/);
      if (!jsonMatch) {
        return { isGenuine: true, score: 1.0 };
      }
      const data = JSON.parse(jsonMatch[0]);
      const score = typeof data.score === "number" ? data.score : 1.0;
      return {
        isGenuine: score >= this.threshold,
        score,
      };
    } catch {
      return { isGenuine: true, score: 1.0 };
    }
  }

  // ─── Batch ─────────────────────────────────────────────────────────

  async validateBatch(texts: string[]): Promise<ValidationResult[]> {
    if (this.healthCheckPromise && !this.healthCheckDone) {
      await this.healthCheckPromise;
    }

    if (this.apiUrl && this.isApiReachable) {
      return this.batchViaApi(texts);
    }

    // Heuristic + optional LM for batch
    const results: ValidationResult[] = [];
    for (const text of texts) {
      const heuristic = this.validateViaHeuristic(text);
      if (!heuristic.isGenuine) {
        results.push(heuristic);
      } else if (this.useLmFallback) {
        results.push(await this.validateViaLm(text));
      } else {
        results.push(heuristic);
      }
    }
    return results;
  }

  private async batchViaApi(texts: string[]): Promise<ValidationResult[]> {
    try {
      const body = JSON.stringify({
        texts,
        threshold: this.threshold,
      });

      const res = await httpPost(
        `${this.apiUrl}/validate/batch`,
        body,
        this.apiKey,
      );
      const data = JSON.parse(res);

      return data.results.map((r: ApiValidateResponse) => ({
        isGenuine: r.is_genuine,
        score: r.genuine_score,
      }));
    } catch (err) {
      this.log(`[BERT] Batch API error: ${err} — all PASS`);
      return texts.map(() => ({ isGenuine: true, score: 1.0 }));
    }
  }

  // ─── Accessors ─────────────────────────────────────────────────────

  getThreshold(): number {
    return this.threshold;
  }

  setThreshold(newThreshold: number): void {
    if (newThreshold < 0 || newThreshold > 1) {
      throw new Error("Threshold must be in [0, 1]");
    }
    this.threshold = newThreshold;
    this.log(`[BERT] Threshold updated: ${newThreshold}`);
  }

  isAvailable(): boolean {
    return this.isApiReachable;
  }

  dispose(): void {
    this.healthCheckPromise = null;
    this.log("[BERT] Disposed");
  }
}
