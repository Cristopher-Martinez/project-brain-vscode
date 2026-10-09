import * as assert from "assert";

// ─── Login Webview & Upgrade Prompt Tests ───────────────────────────────────
// Tests for pure logic — no VS Code API required.

// ─── Upgrade Prompt Feature Info Tests ──────────────────────────────────────

suite("UpgradePrompts — Feature Info", () => {
  type Plan = "free" | "pro" | "team" | "enterprise";
  type FeatureKey =
    | "global_memory"
    | "skill_marketplace"
    | "advanced_model_router"
    | "custom_skills"
    | "analytics_dashboard"
    | "team_shared_memory"
    | "team_skill_library"
    | "team_analytics"
    | "priority_support"
    | "sso_saml"
    | "audit_logging"
    | "custom_deployment"
    | "dedicated_support"
    | "api_access";

  interface FeatureInfo {
    displayName: string;
    description: string;
    requiredPlan: Plan;
  }

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
  };

  test("All 14 features are defined", () => {
    assert.strictEqual(Object.keys(FEATURE_INFO).length, 14);
  });

  test("Pro features require pro plan", () => {
    const proFeatures: FeatureKey[] = [
      "global_memory",
      "skill_marketplace",
      "advanced_model_router",
      "custom_skills",
      "analytics_dashboard",
    ];
    for (const f of proFeatures) {
      assert.strictEqual(
        FEATURE_INFO[f].requiredPlan,
        "pro",
        `${f} should require pro`,
      );
    }
  });

  test("Team features require team plan", () => {
    const teamFeatures: FeatureKey[] = [
      "team_shared_memory",
      "team_skill_library",
      "team_analytics",
      "priority_support",
    ];
    for (const f of teamFeatures) {
      assert.strictEqual(
        FEATURE_INFO[f].requiredPlan,
        "team",
        `${f} should require team`,
      );
    }
  });

  test("Enterprise features require enterprise plan", () => {
    const entFeatures: FeatureKey[] = [
      "sso_saml",
      "audit_logging",
      "custom_deployment",
      "dedicated_support",
      "api_access",
    ];
    for (const f of entFeatures) {
      assert.strictEqual(
        FEATURE_INFO[f].requiredPlan,
        "enterprise",
        `${f} should require enterprise`,
      );
    }
  });

  test("All features have displayName and description", () => {
    for (const [key, info] of Object.entries(FEATURE_INFO)) {
      assert.ok(info.displayName, `${key} missing displayName`);
      assert.ok(info.description, `${key} missing description`);
      assert.ok(info.displayName.length > 3, `${key} displayName too short`);
      assert.ok(info.description.length > 10, `${key} description too short`);
    }
  });
});

// ─── Upgrade Prompt Cooldown Logic Tests ────────────────────────────────────

suite("UpgradePrompts — Cooldown Logic", () => {
  test("Fresh cooldown map has no entries", () => {
    const cooldowns = new Map<string, number>();
    const isOnCooldown = (key: string) => {
      const lastShown = cooldowns.get(key);
      if (!lastShown) return false;
      return Date.now() - lastShown < 3600000;
    };
    assert.ok(!isOnCooldown("global_memory"));
  });

  test("Recent cooldown blocks repeat", () => {
    const cooldowns = new Map<string, number>();
    cooldowns.set("global_memory", Date.now());

    const isOnCooldown = (key: string) => {
      const lastShown = cooldowns.get(key);
      if (!lastShown) return false;
      return Date.now() - lastShown < 3600000;
    };

    assert.ok(isOnCooldown("global_memory"));
  });

  test("Expired cooldown allows repeat", () => {
    const cooldowns = new Map<string, number>();
    cooldowns.set("global_memory", Date.now() - 3700000); // 1h + some

    const isOnCooldown = (key: string, cooldownMs: number) => {
      const lastShown = cooldowns.get(key);
      if (!lastShown) return false;
      return Date.now() - lastShown < cooldownMs;
    };

    assert.ok(!isOnCooldown("global_memory", 3600000));
  });

  test("Different features have independent cooldowns", () => {
    const cooldowns = new Map<string, number>();
    cooldowns.set("global_memory", Date.now());

    const isOnCooldown = (key: string) => {
      const lastShown = cooldowns.get(key);
      if (!lastShown) return false;
      return Date.now() - lastShown < 3600000;
    };

    assert.ok(isOnCooldown("global_memory"));
    assert.ok(!isOnCooldown("skill_marketplace"));
  });
});

// ─── Plan Upgrade Path Tests ────────────────────────────────────────────────

suite("UpgradePrompts — Plan Hierarchy", () => {
  type Plan = "free" | "pro" | "team" | "enterprise";

  const RANK: Record<Plan, number> = {
    free: 0,
    pro: 1,
    team: 2,
    enterprise: 3,
  };

  function getNextPlan(current: Plan): Plan | null {
    const order: Plan[] = ["free", "pro", "team", "enterprise"];
    const idx = order.indexOf(current);
    return idx < order.length - 1 ? order[idx + 1] : null;
  }

  function shouldPrompt(currentPlan: Plan, requiredPlan: Plan): boolean {
    return RANK[currentPlan] < RANK[requiredPlan];
  }

  test("Free → next is Pro", () => {
    assert.strictEqual(getNextPlan("free"), "pro");
  });

  test("Pro → next is Team", () => {
    assert.strictEqual(getNextPlan("pro"), "team");
  });

  test("Team → next is Enterprise", () => {
    assert.strictEqual(getNextPlan("team"), "enterprise");
  });

  test("Enterprise → no next plan", () => {
    assert.strictEqual(getNextPlan("enterprise"), null);
  });

  test("Free user should see pro feature prompt", () => {
    assert.ok(shouldPrompt("free", "pro"));
  });

  test("Pro user should NOT see pro feature prompt", () => {
    assert.ok(!shouldPrompt("pro", "pro"));
  });

  test("Pro user should see team feature prompt", () => {
    assert.ok(shouldPrompt("pro", "team"));
  });

  test("Enterprise user should NOT see any prompt", () => {
    assert.ok(!shouldPrompt("enterprise", "pro"));
    assert.ok(!shouldPrompt("enterprise", "team"));
    assert.ok(!shouldPrompt("enterprise", "enterprise"));
  });
});

// ─── Plan Display Names Tests ───────────────────────────────────────────────

suite("UpgradePrompts — Plan Display", () => {
  const PLAN_DISPLAY: Record<string, string> = {
    free: "Free",
    pro: "Pro ($15/mo)",
    team: "Team ($12/seat/mo)",
    enterprise: "Enterprise",
  };

  test("All plans have display names", () => {
    for (const plan of ["free", "pro", "team", "enterprise"]) {
      assert.ok(PLAN_DISPLAY[plan], `Missing display for ${plan}`);
    }
  });

  test("Pro shows pricing", () => {
    assert.ok(PLAN_DISPLAY["pro"].includes("$15"));
  });

  test("Team shows per-seat pricing", () => {
    assert.ok(PLAN_DISPLAY["team"].includes("$12"));
    assert.ok(PLAN_DISPLAY["team"].includes("seat"));
  });
});

// ─── Login Webview Message Types Tests ────────────────────────────────────────

suite("LoginWebview — Message Handling", () => {
  test("All message types are valid", () => {
    const validTypes = [
      "login",
      "loginGitHub",
      "register",
      "logout",
      "refresh",
      "getStatus",
    ];
    assert.strictEqual(validTypes.length, 6);
    for (const type of validTypes) {
      assert.ok(type.length > 0);
    }
  });

  test("Status response has required fields", () => {
    const status = {
      type: "status" as const,
      authenticated: true,
      plan: "pro" as const,
      isOnline: true,
    };
    assert.strictEqual(status.type, "status");
    assert.ok("authenticated" in status);
    assert.ok("plan" in status);
    assert.ok("isOnline" in status);
  });

  test("Error status includes error field", () => {
    const status = {
      type: "status" as const,
      authenticated: false,
      plan: "free" as const,
      isOnline: false,
      error: "Connection refused",
    };
    assert.ok(status.error);
    assert.strictEqual(status.error, "Connection refused");
  });
});
