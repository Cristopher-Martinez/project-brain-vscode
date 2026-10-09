/**
 * Upgrade Prompts — Contextual plan upgrade suggestions.
 *
 * When a user hits a tier limit, shows an actionable prompt explaining:
 * - What feature they tried to use
 * - Which plan unlocks it
 * - A direct action to view plans
 *
 * Non-intrusive: uses VS Code information messages with action buttons.
 * Rate-limited: same prompt won't show more than once per hour.
 */

import * as vscode from "vscode";
import type { FeatureKey, Plan } from "./saas-client";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface UpgradePromptOptions {
  context: vscode.ExtensionContext;
  log: (msg: string) => void;
  /** Callback when user clicks "View Plans" */
  onViewPlans?: () => void;
  /** Minimum interval between same-feature prompts (ms, default: 1 hour) */
  cooldownMs?: number;
}

interface FeatureInfo {
  displayName: string;
  description: string;
  requiredPlan: Plan;
}

// ─── Feature Descriptions ───────────────────────────────────────────────────

const FEATURE_INFO: Record<FeatureKey, FeatureInfo> = {
  global_memory: {
    displayName: "Global Memory",
    description: "Sync opinions and knowledge across projects",
    requiredPlan: "pro",
  },
  skill_marketplace: {
    displayName: "Skill Marketplace",
    description: "Install and share skills from the community",
    requiredPlan: "pro",
  },
  advanced_model_router: {
    displayName: "Advanced Model Router",
    description: "Smart model selection for optimal responses",
    requiredPlan: "pro",
  },
  custom_skills: {
    displayName: "Custom Skills",
    description: "Create and manage your own skills",
    requiredPlan: "pro",
  },
  custom_personality: {
    displayName: "Custom Personality",
    description:
      "Create a unique AI persona with custom name, creature, tone, and behavior",
    requiredPlan: "pro",
  },
  analytics_dashboard: {
    displayName: "Analytics Dashboard",
    description: "Track usage patterns and insights",
    requiredPlan: "pro",
  },
  team_shared_memory: {
    displayName: "Shared Team Memory",
    description: "Share knowledge across your team",
    requiredPlan: "team",
  },
  team_skill_library: {
    displayName: "Team Skill Library",
    description: "Shared skill collection for your team",
    requiredPlan: "team",
  },
  team_analytics: {
    displayName: "Team Analytics",
    description: "Team-wide usage insights and metrics",
    requiredPlan: "team",
  },
  priority_support: {
    displayName: "Priority Support",
    description: "Fast-track support responses",
    requiredPlan: "team",
  },
  sso_saml: {
    displayName: "SSO / SAML",
    description: "Enterprise single sign-on integration",
    requiredPlan: "enterprise",
  },
  audit_logging: {
    displayName: "Audit Logging",
    description: "Compliance-ready audit trail",
    requiredPlan: "enterprise",
  },
  custom_deployment: {
    displayName: "Custom Deployment",
    description: "Dedicated infrastructure for your organization",
    requiredPlan: "enterprise",
  },
  dedicated_support: {
    displayName: "Dedicated Support",
    description: "Direct engineering support channel",
    requiredPlan: "enterprise",
  },
  api_access: {
    displayName: "API Access",
    description: "Programmatic access to Project Brain services",
    requiredPlan: "enterprise",
  },
  cron_reminders: {
    displayName: "Cron Reminders",
    description: "Scheduled reminders and automated notifications",
    requiredPlan: "pro",
  },
  cloud_storage: {
    displayName: "Cloud Storage",
    description:
      "Sync memory files to the cloud — access from anywhere, reduce local footprint",
    requiredPlan: "pro",
  },
};

const PLAN_DISPLAY: Record<Plan, string> = {
  free: "Free",
  pro: "Pro ($15/mo)",
  team: "Team ($12/seat/mo)",
  enterprise: "Enterprise",
};

// ─── Cooldown State Key ─────────────────────────────────────────────────────

const STATE_KEY = "projectbrain.upgrade.cooldowns";
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// ─── UpgradePromptManager ───────────────────────────────────────────────────

export class UpgradePromptManager {
  private context: vscode.ExtensionContext;
  private log: (msg: string) => void;
  private onViewPlans?: () => void;
  private cooldownMs: number;
  private cooldowns: Map<string, number> = new Map();

  constructor(options: UpgradePromptOptions) {
    this.context = options.context;
    this.log = options.log;
    this.onViewPlans = options.onViewPlans;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;

    // Restore cooldowns from state
    const stored =
      this.context.globalState.get<Record<string, number>>(STATE_KEY);
    if (stored) {
      this.cooldowns = new Map(Object.entries(stored));
    }
  }

  /**
   * Show an upgrade prompt for a feature that requires a higher plan.
   * Returns true if the prompt was shown, false if on cooldown.
   */
  async promptForFeature(
    feature: FeatureKey,
    currentPlan: Plan,
  ): Promise<boolean> {
    // Check cooldown
    if (this.isOnCooldown(feature)) {
      return false;
    }

    const info = FEATURE_INFO[feature];
    if (!info) {
      this.log(`[UpgradePrompt] Unknown feature: ${feature}`);
      return false;
    }

    // Don't prompt if already on the required plan or higher
    const RANK: Record<Plan, number> = {
      free: 0,
      pro: 1,
      team: 2,
      enterprise: 3,
    };
    if (RANK[currentPlan] >= RANK[info.requiredPlan]) {
      return false;
    }

    // Set cooldown
    await this.setCooldown(feature);

    // Show prompt
    const planName = PLAN_DISPLAY[info.requiredPlan];
    const message = `${info.displayName}: ${info.description}. Available on ${planName}.`;

    const action = await vscode.window.showInformationMessage(
      `🧠 ${message}`,
      "View Plans",
      "Dismiss",
    );

    if (action === "View Plans") {
      this.log(`[UpgradePrompt] User clicked View Plans for ${feature}`);
      if (this.onViewPlans) {
        this.onViewPlans();
      } else {
        // Default: open external pricing page
        await vscode.env.openExternal(
          vscode.Uri.parse("https://projectbrain.dev/pricing"),
        );
      }
    }

    return true;
  }

  /**
   * Show a limit-reached prompt (e.g., max custom skills).
   */
  async promptForLimit(
    limitType: string,
    currentCount: number,
    maxCount: number,
    currentPlan: Plan,
  ): Promise<boolean> {
    const cooldownKey = `limit_${limitType}`;
    if (this.isOnCooldown(cooldownKey)) {
      return false;
    }

    await this.setCooldown(cooldownKey);

    const nextPlan = this.getNextPlan(currentPlan);
    const nextPlanName = nextPlan ? PLAN_DISPLAY[nextPlan] : "a higher plan";

    const message = `You've reached the limit of ${maxCount} ${limitType} on the ${PLAN_DISPLAY[currentPlan]} plan (${currentCount}/${maxCount}). Upgrade to ${nextPlanName} for more.`;

    const action = await vscode.window.showInformationMessage(
      `🧠 ${message}`,
      "View Plans",
      "Dismiss",
    );

    if (action === "View Plans") {
      if (this.onViewPlans) {
        this.onViewPlans();
      } else {
        await vscode.env.openExternal(
          vscode.Uri.parse("https://projectbrain.dev/pricing"),
        );
      }
    }

    return true;
  }

  /**
   * Check and potentially prompt — convenience for feature gating code.
   * Returns false if the feature is not available (and prompt shown/cooldown).
   */
  async gateFeature(
    feature: FeatureKey,
    currentPlan: Plan,
    availableFeatures: FeatureKey[],
  ): Promise<boolean> {
    if (availableFeatures.includes(feature)) {
      return true; // Feature available
    }
    await this.promptForFeature(feature, currentPlan);
    return false;
  }

  /** Clear all cooldowns (for testing). */
  async clearCooldowns(): Promise<void> {
    this.cooldowns.clear();
    await this.context.globalState.update(STATE_KEY, {});
  }

  // ─── Internal ──────────────────────────────────────────────────────

  private isOnCooldown(key: string): boolean {
    const lastShown = this.cooldowns.get(key);
    if (!lastShown) return false;
    return Date.now() - lastShown < this.cooldownMs;
  }

  private async setCooldown(key: string): Promise<void> {
    this.cooldowns.set(key, Date.now());
    const obj = Object.fromEntries(this.cooldowns);
    await this.context.globalState.update(STATE_KEY, obj);
  }

  private getNextPlan(current: Plan): Plan | null {
    const order: Plan[] = ["free", "pro", "team", "enterprise"];
    const idx = order.indexOf(current);
    return idx < order.length - 1 ? order[idx + 1] : null;
  }
}

/** Get the feature info for a given feature key. Exported for testing. */
export function getFeatureInfo(feature: FeatureKey): FeatureInfo | undefined {
  return FEATURE_INFO[feature];
}

/** Get plan display name. Exported for testing. */
export function getPlanDisplay(plan: Plan): string {
  return PLAN_DISPLAY[plan];
}
