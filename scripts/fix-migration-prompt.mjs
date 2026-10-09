import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const filePath = resolve(import.meta.dirname, "..", "src", "loop-migration.ts");
let content = readFileSync(filePath, "utf8");

// Replace the old migration prompt that tells agent to resume with sessionId
// with a new prompt that tells agent to start a FRESH loop
const oldPromptPart =
  /`Llama a \\`loop\(sessionId=.*?\)\\`.*?para resumir\.`,\s*"El sistema detectar.*?contexto previo\.",/s;
const newPromptPart = `"Llama a \`loop(action: \\"start\\")\` para iniciar un loop FRESCO.",
    "NO uses resume \\u2014 esta sesi\\u00f3n es nueva. El contexto del loop anterior",
    "ya est\\u00e1 incluido abajo.",
    "",
    snapshot.goal ? \`**Goal anterior:** \${snapshot.goal}\` : "",`;

if (oldPromptPart.test(content)) {
  content = content.replace(oldPromptPart, newPromptPart);
  // Also fix the last line about "tras resumir el loop"
  content = content.replace(
    /Procesa este feedback como tu primera tarea tras resumir el loop\./,
    "Procesa este feedback como tu primera tarea en el nuevo loop.",
  );
  // Fix any U+FFFD replacement characters in Spanish text
  content = content.replace(/autom\ufffdtica/g, "autom\u00e1tica");
  content = content.replace(/detectar\ufffd/g, "detectar\u00e1");
  content = content.replace(/restaurar\ufffd/g, "restaurar\u00e1");
  writeFileSync(filePath, content, "utf8");
  console.log("✅ Migration prompt updated successfully");
} else {
  console.log("⚠️  Pattern not found — prompt may have already been updated");
  // Still fix U+FFFD chars
  const fixed = content
    .replace(/autom\ufffdtica/g, "autom\u00e1tica")
    .replace(/detectar\ufffd/g, "detectar\u00e1")
    .replace(/restaurar\ufffd/g, "restaurar\u00e1");
  if (fixed !== content) {
    writeFileSync(filePath, fixed, "utf8");
    console.log("✅ Fixed U+FFFD replacement characters");
  }
}
