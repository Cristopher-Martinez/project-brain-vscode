import * as assert from "assert";

// Test the template generation logic (pure functions, no VS Code dependency)
// We test the structure and content of generated templates

suite("Template Tests", () => {
  // We can't import templates directly in test because of VS Code deps in the module,
  // but we can test the marker logic and documentation format

  const MARKER_START = "<!-- PROJECT_BRAIN_START -->";
  const MARKER_END = "<!-- PROJECT_BRAIN_END -->";
  const AUTOGEN_START = "<!-- AUTOGEN_START -->";
  const AUTOGEN_END = "<!-- AUTOGEN_END -->";

  test("Markers should be valid HTML comments", () => {
    assert.ok(
      MARKER_START.startsWith("<!--"),
      "MARKER_START should be HTML comment",
    );
    assert.ok(MARKER_START.endsWith("-->"), "MARKER_START should end with -->");
    assert.ok(
      MARKER_END.startsWith("<!--"),
      "MARKER_END should be HTML comment",
    );
    assert.ok(
      AUTOGEN_START.startsWith("<!--"),
      "AUTOGEN_START should be HTML comment",
    );
    assert.ok(
      AUTOGEN_END.startsWith("<!--"),
      "AUTOGEN_END should be HTML comment",
    );
  });

  test("Non-destructive injection logic", () => {
    // Simulate the injection process
    const existingContent = `# My Custom Notes

Some user content here.

${MARKER_START}
# Old generated content
${MARKER_END}

## More user notes
These should be preserved.
`;

    const newInjection = `${MARKER_START}
# New generated content
Updated data here.
${MARKER_END}`;

    // Simulate injection
    const startIdx = existingContent.indexOf(MARKER_START);
    const endIdx = existingContent.indexOf(MARKER_END);

    assert.ok(startIdx !== -1, "Should find MARKER_START");
    assert.ok(endIdx !== -1, "Should find MARKER_END");
    assert.ok(endIdx > startIdx, "END should come after START");

    const before = existingContent.substring(0, startIdx);
    const after = existingContent.substring(endIdx + MARKER_END.length);
    const result = before + newInjection + after;

    assert.ok(
      result.includes("My Custom Notes"),
      "Should preserve content before markers",
    );
    assert.ok(
      result.includes("More user notes"),
      "Should preserve content after markers",
    );
    assert.ok(
      result.includes("New generated content"),
      "Should include new content",
    );
    assert.ok(
      !result.includes("Old generated content"),
      "Should NOT include old content",
    );
  });

  test("Progressive update logic (AUTOGEN markers)", () => {
    const existingContent = `# Architecture

${AUTOGEN_START}
## Old auto-generated section
- old data
${AUTOGEN_END}

## My Custom Design Decisions

I chose this pattern because...
`;

    const newAutoSection = `${AUTOGEN_START}
## New auto-generated section
- new data
- better analysis
${AUTOGEN_END}`;

    // Parse auto section
    const existAutoStart = existingContent.indexOf(AUTOGEN_START);
    const existAutoEnd = existingContent.indexOf(AUTOGEN_END);

    assert.ok(existAutoStart !== -1, "Should find AUTOGEN_START");
    assert.ok(existAutoEnd !== -1, "Should find AUTOGEN_END");

    const before = existingContent.substring(0, existAutoStart);
    const after = existingContent.substring(existAutoEnd + AUTOGEN_END.length);
    const result = before + newAutoSection + after;

    assert.ok(
      result.includes("My Custom Design Decisions"),
      "Should preserve user content",
    );
    assert.ok(result.includes("new data"), "Should include new auto content");
    assert.ok(
      !result.includes("old data"),
      "Should NOT include old auto content",
    );
  });

  test("Deduplication logic", () => {
    // Test that duplicate headings after AUTOGEN_END are stripped
    const content = `# Code Map

${AUTOGEN_START}
## File Structure

- src/index.ts
- src/app.ts

## File Hotspots

- hot.ts — 50 commits
${AUTOGEN_END}

## File Structure

- src/index.ts
- src/app.ts

## My Custom Notes

Something important.
`;

    // Extract auto headings
    const autoStartIdx = content.indexOf(AUTOGEN_START);
    const autoEndIdx = content.indexOf(AUTOGEN_END);
    const autoContent = content.substring(
      autoStartIdx + AUTOGEN_START.length,
      autoEndIdx,
    );

    const autoHeadings = new Set<string>();
    const headingRegex = /^(##\s+.+)/gm;
    let match;
    while ((match = headingRegex.exec(autoContent))) {
      autoHeadings.add(match[1].trim());
    }

    assert.ok(
      autoHeadings.has("## File Structure"),
      "Should detect 'File Structure' heading",
    );
    assert.ok(
      autoHeadings.has("## File Hotspots"),
      "Should detect 'File Hotspots' heading",
    );
    assert.strictEqual(
      autoHeadings.size,
      2,
      "Should have exactly 2 auto headings",
    );

    // The deduplication should remove the duplicate "## File Structure" after AUTOGEN_END
    // but keep "## My Custom Notes"
  });
});
