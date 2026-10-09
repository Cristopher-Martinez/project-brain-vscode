import fs from "fs";

const filePath = "src/loop-migration.ts";
let content = fs.readFileSync(filePath, "utf-8");

// Replace the loop call instruction in buildMigrationPrompt
const oldLine =
  'Then call loop con sessionId="\\${sid}" y goal="\\${goal}" para iniciar.';
const newLine =
  'Then call loop con action="start" y goal="\\${goal}" para iniciar. NO uses resume \\u2014 tu contexto ya est\\u00E1 arriba.';

// Use template literal markers to find the line
const searchStr = '`Then call loop con sessionId="';
const replaceTarget = content.indexOf(searchStr);

if (replaceTarget === -1) {
  console.error("Could not find the loop call line in buildMigrationPrompt");
  console.error("Searching for:", searchStr);
  process.exit(1);
}

// Find the full line (from backtick to backtick+comma)
const lineEnd = content.indexOf("`,", replaceTarget);
if (lineEnd === -1) {
  console.error("Could not find line end");
  process.exit(1);
}

const oldFullLine = content.substring(replaceTarget, lineEnd + 2);
console.log("Found:", oldFullLine);

const newFullLine =
  '`Then call loop con action="start" y goal="${goal}" para iniciar. NO uses resume \\u2014 tu contexto ya est\\u00E1 arriba.`,';

content =
  content.substring(0, replaceTarget) +
  newFullLine +
  content.substring(lineEnd + 2);

fs.writeFileSync(filePath, content, "utf-8");
console.log(
  "✅ Migration prompt updated to use action='start' for fresh counter",
);
