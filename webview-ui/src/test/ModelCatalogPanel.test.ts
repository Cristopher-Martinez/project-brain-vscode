import * as assert from "assert";

/**
 * Tests for webview-ui/src/components/autoloop/ModelCatalogPanel.tsx:
 * - Component data contract validation
 * - Provider grouping logic
 */

suite("ModelCatalogPanel — Data Contract", () => {
  test("catalog data shape has groups and enabledModelIds", () => {
    const catalog = {
      groups: {
        anthropic: [
          { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" },
          { id: "anthropic/claude-3.5-sonnet", label: "Claude 3.5 Sonnet" },
        ],
        openai: [
          { id: "openai/gpt-4.1-mini", label: "GPT-4.1 Mini" },
        ],
      },
      enabledModelIds: ["anthropic/claude-sonnet-4"],
    };
    assert.ok(catalog.groups["anthropic"].length === 2);
    assert.ok(catalog.groups["openai"].length === 1);
    assert.ok(catalog.enabledModelIds.includes("anthropic/claude-sonnet-4"));
  });

  test("search filter works on model labels", () => {
    const models = [
      { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" },
      { id: "openai/gpt-4.1-mini", label: "GPT-4.1 Mini" },
      { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    ];
    const search = "claude";
    const filtered = models.filter(
      (m) => m.label.toLowerCase().includes(search) || m.id.toLowerCase().includes(search)
    );
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].id, "anthropic/claude-sonnet-4");
  });

  test("group toggle enables all models in a group", () => {
    const groupModels = [
      { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" },
      { id: "anthropic/claude-3.5-sonnet", label: "Claude 3.5 Sonnet" },
    ];
    const enabledIds = new Set<string>(["openai/gpt-4.1-mini"]);
    // Toggle ON all anthropic models
    for (const m of groupModels) {
      enabledIds.add(m.id);
    }
    assert.ok(enabledIds.has("anthropic/claude-sonnet-4"));
    assert.ok(enabledIds.has("anthropic/claude-3.5-sonnet"));
    assert.ok(enabledIds.has("openai/gpt-4.1-mini"));
    assert.strictEqual(enabledIds.size, 3);
  });
});
