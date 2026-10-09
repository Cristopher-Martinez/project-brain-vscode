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
  const branch = snapshot.branchName || "(sin branch)";
  const lastSynthesis = snapshot.lastSynthesis
    ? snapshot.lastSynthesis.substring(0, 500)
    : "(sin s\\u00EDntesis previa)";

  return [
    \`LOOP_SESSION [sessionId=\${sid}]\`,
    \`Objetivo: \${goal}\`,
    "",
    "\\u2600\\uFE0F FAST RESUME \\u2014 Sesi\\u00F3n migrada por agotamiento de contexto",
    \`Objetivo original: \${goal}\`,
    \`Iteraciones completadas: \${snapshot.currentRound}\`,
    \`Branch: \${branch}\`,
    "",
    "\\u00DAltima s\\u00EDntesis antes de migrar:",
    lastSynthesis,
    "",
    "Feedback pendiente del usuario:",
    pendingFeedback,
    "",
    "\\u26A1 FAST RESUME \\u2014 Tu contexto est\\u00E1 completo arriba.",
    "NO necesitas buscar en memoria ni re-leer archivos.",
    "Ve DIRECTO a procesar y llama loopAwaitInput con tu plan de acci\\u00F3n.",
    "",
    "\\u26A1 FAST RESUME:",
    '0. FIRST call tool_search_tool_regex({ pattern: "projectBrain" }) to load loop tools.',
    "",
    \`Then call loop con sessionId="\${sid}" y goal="\${goal}" para iniciar.\`,
    "NO hagas b\\u00FAsquedas de memoria ni re-lectura innecesaria. Tu contexto est\\u00E1 completo arriba.",
  ].join("\\n");
}`;

content =
  content.substring(0, funcStart) + newFunc + content.substring(funcEnd + 2);

fs.writeFileSync(filePath, content, "utf-8");
console.log(
  "✅ Migration prompt updated to FAST RESUME format with rich context",
);
