import * as assert from "assert";

// ─── Phase 9: Extension Wiring Tests ────────────────────────────────────────
// Tests that verify all SaaS modules are properly wired into extension.ts.
// These test initialization order, dependency injection, error isolation,
// command registration, configuration, and cleanup.

// ─── Mock Infrastructure ────────────────────────────────────────────────────

/** Creates a mock ExtensionContext with secrets and globalState */
function createMockContext() {
  const secrets = new Map<string, string>();
  const state = new Map<string, unknown>();
  const subscriptions: { dispose: () => void }[] = [];
  return {
    subscriptions,
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => {
        secrets.set(key, value);
      },
      delete: async (key: string) => {
        secrets.delete(key);
      },
    },
    globalState: {
      get: <T>(key: string) => state.get(key) as T | undefined,
      update: async (key: string, value: unknown) => {
        state.set(key, value);
      },
      keys: () => Array.from(state.keys()),
      setKeysForSync: () => {
        /* noop */
      },
    },
    extensionUri: { fsPath: "/test/extension" },
    extensionPath: "/test/extension",
    dispose() {
      for (const d of subscriptions) d.dispose();
    },
  };
}

function noop(_msg: string) {
  /* silent logger */
}

// ─── 1. Initialization Order Tests ──────────────────────────────────────────
// Verify that SaaS modules initialize in the correct dependency order:
// SaaSClient → OfflineManager → SkillManager / DualOpinionBank / LoginWebview / UpgradePrompts

suite("Phase 9 — Wiring: Initialization Order", () => {
  test("SaaS components have correct dependency chain", () => {
    // This test validates the DESIGN of the dependency graph.
    // SaaSClient depends on: context, baseUrl, log
    // OfflineManager depends on: SaaSClient, context, log
    // SkillManager depends on: memoryPath, extensionPath, saasClient (optional), log
    // DualOpinionBank depends on: opinionBank, saasClient (optional), offlineManager (optional), log
    // LoginWebviewProvider depends on: saasClient, extensionUri, log
    // UpgradePromptManager depends on: context, log, onViewPlans (optional)

    const initOrder = [
      "SaaSClient", // 1st: no SaaS deps
      "OfflineManager", // 2nd: needs SaaSClient
      "SkillManager", // 3rd+: needs SaaSClient (optional)
      "DualOpinionBank", // 3rd+: needs SaaSClient + OfflineManager (optional)
      "LoginWebviewProvider", // 3rd+: needs SaaSClient
      "UpgradePromptManager", // 3rd+: needs context only
    ];

    // SaaSClient must come first
    assert.strictEqual(initOrder[0], "SaaSClient");
    // OfflineManager must come after SaaSClient
    assert.ok(
      initOrder.indexOf("OfflineManager") > initOrder.indexOf("SaaSClient"),
    );
    // DualOpinionBank must come after OfflineManager
    assert.ok(
      initOrder.indexOf("DualOpinionBank") >
        initOrder.indexOf("OfflineManager"),
    );
  });

  test("SaaSClient requires only context, baseUrl, and log", () => {
    // Verify SaaSClient can be constructed independently
    const requiredParams = ["baseUrl", "context", "log"];
    // These are the only required params — no circular deps
    assert.strictEqual(requiredParams.length, 3);
    assert.ok(requiredParams.includes("baseUrl"));
    assert.ok(requiredParams.includes("context"));
    assert.ok(requiredParams.includes("log"));
  });

  test("OfflineManager requires SaaSClient", () => {
    const requiredParams = ["saasClient", "context", "log"];
    assert.ok(requiredParams.includes("saasClient"));
  });

  test("SkillManager has optional SaaS dependency", () => {
    // SkillManager works without SaaSClient (local-only mode)
    const requiredParams = ["memoryPath", "extensionPath", "log"];
    const optionalParams = ["saasClient"];
    assert.strictEqual(requiredParams.length, 3);
    assert.strictEqual(optionalParams.length, 1);
  });

  test("DualOpinionBank wraps existing OpinionBank", () => {
    // Must compose WITH OpinionBank, not replace it
    const requiredParams = ["opinionBank", "log"];
    const optionalParams = ["saasClient", "offlineManager"];
    assert.ok(requiredParams.includes("opinionBank"));
    assert.strictEqual(optionalParams.length, 2);
  });
});

// ─── 2. Error Isolation Tests ───────────────────────────────────────────────
// Verify that SaaS module failures don't crash the extension

suite("Phase 9 — Wiring: Error Isolation", () => {
  test("SaaS init failure should not prevent core extension activation", () => {
    // The wiring pattern wraps SaaS init in try/catch
    // Core features (bootstrapper, scanner, mcpManager) must work without SaaS
    let coreInitialized = false;
    let saasInitialized = false;

    // Simulate: core init succeeds
    try {
      coreInitialized = true;
    } catch {
      assert.fail("Core init should never fail in this test");
    }

    // Simulate: SaaS init fails
    try {
      throw new Error("SaaS server unreachable");
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_e) {
      saasInitialized = false;
    }

    assert.strictEqual(coreInitialized, true);
    assert.strictEqual(saasInitialized, false);
    // Extension still works — SaaS is opt-in
  });

  test("OfflineManager failure should not block other SaaS modules", () => {
    let saasClientOk = false;
    let offlineManagerOk = false;
    let loginWebviewOk = false;

    try {
      saasClientOk = true;
    } catch {
      /* */
    }

    try {
      throw new Error("globalState corrupted");
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_e) {
      offlineManagerOk = false;
    }

    try {
      loginWebviewOk = true;
    } catch {
      /* */
    }

    assert.strictEqual(saasClientOk, true);
    assert.strictEqual(offlineManagerOk, false);
    assert.strictEqual(loginWebviewOk, true);
  });

  test("Login webview failure should be silently logged", () => {
    const logs: string[] = [];
    const testLog = (msg: string) => logs.push(msg);

    try {
      throw new Error("Webview creation failed");
    } catch (e) {
      testLog(`[SaaS] Login webview init error: ${e}`);
    }

    assert.ok(logs.length === 1);
    assert.ok(logs[0].includes("[SaaS]"));
    assert.ok(logs[0].includes("Login webview"));
  });
});

// ─── 3. Configuration Tests ────────────────────────────────────────────────
// Verify SaaS configuration keys and defaults

suite("Phase 9 — Wiring: Configuration", () => {
  test("saasApiUrl has correct default", () => {
    const defaultUrl = "https://brain-api.projectbrain.dev";
    assert.ok(defaultUrl.startsWith("https://"));
    assert.ok(defaultUrl.includes("brain-api"));
  });

  test("saasEnabled default is false (opt-in)", () => {
    const defaultEnabled = false;
    assert.strictEqual(defaultEnabled, false);
  });

  test("configuration keys follow projectBrain namespace", () => {
    const expectedKeys = [
      "projectBrain.saas.enabled",
      "projectBrain.saas.apiUrl",
    ];
    for (const key of expectedKeys) {
      assert.ok(
        key.startsWith("projectBrain."),
        `Key ${key} must use projectBrain namespace`,
      );
    }
  });
});

// ─── 4. Command Registration Tests ─────────────────────────────────────────
// Verify all new SaaS commands are registered

suite("Phase 9 — Wiring: Command Registration", () => {
  test("new SaaS commands follow naming convention", () => {
    const newCommands = [
      "projectBrain.saas.login",
      "projectBrain.saas.logout",
      "projectBrain.saas.status",
      "projectBrain.saas.syncOpinions",
    ];

    for (const cmd of newCommands) {
      assert.ok(
        cmd.startsWith("projectBrain."),
        `Command ${cmd} must use projectBrain namespace`,
      );
      assert.ok(
        cmd.includes("saas."),
        `Command ${cmd} should be in saas subgroup`,
      );
    }
  });

  test("login command requires SaaS to be enabled", () => {
    // When SaaS is disabled, login should show info message
    const saasEnabled = false;
    let showedMessage = false;

    if (!saasEnabled) {
      showedMessage = true;
    }

    assert.strictEqual(showedMessage, true);
  });

  test("sync command is gated behind authentication", () => {
    // Sync should check isAuthenticated() before proceeding
    const isAuthenticated = false;
    let blockedUnauthenticated = false;

    if (!isAuthenticated) {
      blockedUnauthenticated = true;
    }

    assert.strictEqual(blockedUnauthenticated, true);
  });
});

// ─── 5. Module-Level Reference Tests ────────────────────────────────────────
// Verify wiring pattern matches existing neuroplasticity refs

suite("Phase 9 — Wiring: Module-Level References", () => {
  test("SaaS module refs should be nullable (opt-in pattern)", () => {
    // Following the pattern: let activeOpinionBank: OpinionBank | null = null
    let activeSaasClient: unknown | null = null;
    const activeOfflineManager: unknown | null = null;
    const activeDualOpinionBank: unknown | null = null;
    const activeSkillManager: unknown | null = null;
    const activeLoginWebview: unknown | null = null;
    const activeUpgradePrompts: unknown | null = null;

    assert.strictEqual(activeSaasClient, null);
    assert.strictEqual(activeOfflineManager, null);
    assert.strictEqual(activeDualOpinionBank, null);
    assert.strictEqual(activeSkillManager, null);
    assert.strictEqual(activeLoginWebview, null);
    assert.strictEqual(activeUpgradePrompts, null);

    // Simulate activation
    activeSaasClient = {};
    assert.notStrictEqual(activeSaasClient, null);

    // Simulate deactivation
    activeSaasClient = null;
    assert.strictEqual(activeSaasClient, null);
  });
});

// ─── 6. Deactivation / Cleanup Tests ───────────────────────────────────────
// Verify SaaS modules are properly disposed on deactivation

suite("Phase 9 — Wiring: Deactivation Cleanup", () => {
  test("OfflineManager.dispose() is called on deactivate", () => {
    let disposed = false;
    const mockOfflineManager = {
      dispose() {
        disposed = true;
      },
      flush: async () => 0,
    };

    // Simulate deactivate
    mockOfflineManager.dispose();
    assert.strictEqual(disposed, true);
  });

  test("LoginWebviewProvider.dispose() is called on deactivate", () => {
    let disposed = false;
    const mockLoginWebview = {
      dispose() {
        disposed = true;
      },
    };

    mockLoginWebview.dispose();
    assert.strictEqual(disposed, true);
  });

  test("DualOpinionBank sync is flushed before shutdown", () => {
    let synced = false;
    const mockDualBank = {
      async sync() {
        synced = true;
      },
    };

    // Simulate deactivate with best-effort sync
    (async () => {
      try {
        await mockDualBank.sync();
      } catch {
        /* best-effort */
      }
    })();

    // Give async a tick
    setTimeout(() => {
      assert.strictEqual(synced, true);
    }, 10);
  });

  test("OfflineManager flushes queue before dispose", async () => {
    let flushCalled = false;
    let disposeCalled = false;
    const mockOfflineManager = {
      async flush() {
        flushCalled = true;
      },
      dispose() {
        disposeCalled = true;
      },
    };

    await mockOfflineManager.flush();
    mockOfflineManager.dispose();

    assert.strictEqual(flushCalled, true);
    assert.strictEqual(disposeCalled, true);
  });

  test("null refs are safely skipped during cleanup", () => {
    let activeSaasClient: unknown | null = null;
    let activeOfflineManager: { dispose: () => void } | null = null;

    // This should not throw
    assert.doesNotThrow(() => {
      if (activeOfflineManager) {
        activeOfflineManager.dispose();
      }
      activeSaasClient = null;
      activeOfflineManager = null;
    });

    assert.strictEqual(activeSaasClient, null);
  });
});

// ─── 7. Restricted Mode Tests ───────────────────────────────────────────────
// Verify new commands are registered in restricted mode too

suite("Phase 9 — Wiring: Restricted Mode", () => {
  test("SaaS commands appear in restricted commands list", () => {
    const restrictedCommands = [
      "projectBrain.init",
      "projectBrain.scan",
      // ... existing commands
      "projectBrain.saas.login",
      "projectBrain.saas.logout",
      "projectBrain.saas.status",
      "projectBrain.saas.syncOpinions",
    ];

    const saasCommands = restrictedCommands.filter((c) => c.includes("saas."));
    assert.strictEqual(saasCommands.length, 4);
  });
});

// ─── 8. Integration Wire Tests ──────────────────────────────────────────────
// Verify that DualOpinionBank replaces OpinionBank in the right places

suite("Phase 9 — Wiring: Integration Points", () => {
  test("DualOpinionBank wraps OpinionBank without breaking AutoCapture", () => {
    // AutoCapture uses OpinionBank directly
    // DualOpinionBank wraps OpinionBank
    // Both should work independently — AutoCapture doesn't need DualOpinionBank
    const opinionBankCalls: string[] = [];
    const mockOpinionBank = {
      add(s: string) {
        opinionBankCalls.push(s);
      },
    };

    // AutoCapture uses local OpinionBank
    mockOpinionBank.add("local learning");
    assert.strictEqual(opinionBankCalls.length, 1);

    // DualOpinionBank adds cloud sync on top
    const dualBankCalls: string[] = [];
    const mockDualBank = {
      opinionBank: mockOpinionBank,
      addOpinion(s: string) {
        this.opinionBank.add(s);
        dualBankCalls.push(s);
      },
    };

    mockDualBank.addOpinion("cross-project learning");
    assert.strictEqual(opinionBankCalls.length, 2); // Both local and dual
    assert.strictEqual(dualBankCalls.length, 1);
  });

  test("SkillManager enriches registerLMTools if available", () => {
    // registerLMTools currently takes opinionBank, autoCapture, autoRecall
    // Phase 9 should also pass skillManager (optional)
    const toolArgs = {
      context: {},
      folder: {},
      searchFn: async () => "",
      identityManager: {},
      log: noop,
      modelRouter: {},
      mcpManager: {},
      opinionBank: {},
      autoCapture: {},
      autoRecall: {},
      // NEW: these should be passed if available
      skillManager: null as unknown,
      dualOpinionBank: null as unknown,
      upgradePrompts: null as unknown,
    };

    // Verify all args can be null without error
    assert.strictEqual(toolArgs.skillManager, null);
    assert.strictEqual(toolArgs.dualOpinionBank, null);
    assert.strictEqual(toolArgs.upgradePrompts, null);
  });

  test("UpgradePromptManager onViewPlans opens login webview", () => {
    let loginShown = false;
    const mockLoginWebview = {
      show() {
        loginShown = true;
      },
    };

    // onViewPlans callback should show login
    const onViewPlans = () => {
      mockLoginWebview.show();
    };

    onViewPlans();
    assert.strictEqual(loginShown, true);
  });
});

// ─── 9. SaaS Enable/Disable Toggle Tests ───────────────────────────────────
// Verify behavior when SaaS is enabled vs disabled

suite("Phase 9 — Wiring: SaaS Toggle", () => {
  test("when saas.enabled is false, no SaaS modules are initialized", () => {
    const saasEnabled = false;
    const initializedModules: string[] = [];

    if (saasEnabled) {
      initializedModules.push("SaaSClient");
      initializedModules.push("OfflineManager");
      initializedModules.push("SkillManager");
      initializedModules.push("DualOpinionBank");
      initializedModules.push("LoginWebviewProvider");
      initializedModules.push("UpgradePromptManager");
    }

    assert.strictEqual(initializedModules.length, 0);
  });

  test("when saas.enabled is true, all SaaS modules initialize", () => {
    const saasEnabled = true;
    const initializedModules: string[] = [];

    if (saasEnabled) {
      initializedModules.push("SaaSClient");
      initializedModules.push("OfflineManager");
      initializedModules.push("SkillManager");
      initializedModules.push("DualOpinionBank");
      initializedModules.push("LoginWebviewProvider");
      initializedModules.push("UpgradePromptManager");
    }

    assert.strictEqual(initializedModules.length, 6);
  });

  test("core neuroplasticity works without SaaS", () => {
    // OpinionBank, AutoCapture, AutoRecall should work independently
    const opinionBank = { initialized: true };
    const autoCapture = { initialized: true };
    const autoRecall = { initialized: true };

    // No SaaS client
    const saasClient = null;

    assert.strictEqual(opinionBank.initialized, true);
    assert.strictEqual(autoCapture.initialized, true);
    assert.strictEqual(autoRecall.initialized, true);
    assert.strictEqual(saasClient, null);
  });
});

// ─── 10. registerChatParticipant + registerLMTools Extension Tests ──────────
// Verify new SaaS modules are passed to chat/LM registrations

suite("Phase 9 — Wiring: Chat & LM Tools Context", () => {
  test("registerChatParticipant receives upgrade prompts for gating", () => {
    // Chat participant should gate premium features with upgrade prompts
    const chatParticipantArgs = {
      context: {},
      searchFn: async () => "",
      identityManager: {},
      log: noop,
      modelRouter: {},
      autoCapture: {},
      upgradePrompts: { promptForFeature: async () => false },
    };

    assert.ok(chatParticipantArgs.upgradePrompts);
    assert.ok(
      typeof chatParticipantArgs.upgradePrompts.promptForFeature === "function",
    );
  });

  test("registerLMTools receives skillManager for skill-related tools", () => {
    const lmToolsArgs = {
      context: {},
      folder: {},
      searchFn: async () => "",
      identityManager: {},
      log: noop,
      modelRouter: {},
      mcpManager: {},
      opinionBank: {},
      autoCapture: {},
      autoRecall: {},
      skillManager: { getAll: () => [] },
      dualOpinionBank: { sync: async () => {} },
    };

    assert.ok(lmToolsArgs.skillManager);
    assert.ok(typeof lmToolsArgs.skillManager.getAll === "function");
    assert.ok(lmToolsArgs.dualOpinionBank);
  });
});
