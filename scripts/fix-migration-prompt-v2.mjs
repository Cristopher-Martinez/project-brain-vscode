import fs from "fs";

const filePath = "src/loop-migration.ts";
let content = fs.readFileSync(filePath, "utf-8");

// Find buildMigrationPrompt function and replace it entirely
const funcStart = content.indexOf("function buildMigrationPrompt(");
const funcEnd = content.indexOf("\n}", funcStart);
if (funcStart === -1 || funcEnd === -1) {
  console.error("Could not find buildMigrationPrompt function");
  process.exit(1);
}

const newFunc = `function buildMigrationPrompt(
  pendingFeedback: string,
  snapshot: HibernatedLoop,
): string {
  const sid = snapshot.sessionId;
  const goal = snapshot.goal || "Continuar trabajo del loop anterior";
  const migrationNote =
    \`Migrado desde sesi\u00F3n \${sid.substring(0, 8)} despu\u00E9s de \` +
    \`\${snapshot.currentRound} iteraciones. \${goal}. \` +
    \`Feedback pendiente: \${pendingFeedback}\`;

  return [
    \`LOOP_SESSION [sessionId=\${sid}]\`,
    \`Objetivo: \${migrationNote}\`,
    "",
    "LOOP PROTOCOL (MANDATORY)",
    'FIRST call tool_search_tool_regex({ pattern: "projectBrain" }) to load loop tools. Without this step, loop tools DO NOT EXIST in your toolset.',
    \`Call loop tool with sessionId="\${sid}" and goal="\${goal}" to START.\`,
    \`Do your work, then call loopAwaitInput(sessionId="\${sid}", synthesis="...") with your results.\`,
    "NEVER respond directly to the user \\u2014 ALL output goes through loopAwaitInput.",
    "After receiving feedback \\u2192 process it \\u2192 loopAwaitInput again.",
    \`To end the loop, call loopEnd(sessionId="\${sid}").\`,
    'Gate check: "Am I in a loop? \\u2192 loopAwaitInput. No exceptions."',
  ].join("\\n");
}`;

content =
  content.substring(0, funcStart) + newFunc + content.substring(funcEnd + 2);

fs.writeFileSync(filePath, content, "utf-8");
console.log(
  "✅ Migration prompt updated to LOOP_SESSION + LOOP PROTOCOL structure",
);
