import { readFileSync, writeFileSync } from "fs";

let c = readFileSync("src/invariants-manager.ts", "utf-8");
const before = c.split("\n").length;

// Step 1: Remove section separator comments (5 lines saved)
c = c.replace(/^\/\/ \u2014\u2014\u2014[^\n]*\n/gm, "");

// Step 2: Add warnings param to writeInvariantsDoc
c = c.replace(
  `export function writeInvariantsDoc(
  wsRoot: string,
  records: InvariantRecord[]
): void {`,
  `export function writeInvariantsDoc(
  wsRoot: string,
  records: InvariantRecord[],
  warnings?: string[]
): void {`,
);

// Step 3: Add warnings section before writeFileSync
const oldWrite = `  writeFileSync(join(wsRoot, INVARIANTS_FILE), lines.join('\\n'), 'utf-8');`;
const newWrite = `  if (warnings?.length) {
    lines.push('## \u26a0\ufe0f Warnings', '', ...warnings.map(w => \`- \${w}\`), '');
  }
  writeFileSync(join(wsRoot, INVARIANTS_FILE), lines.join('\\n'), 'utf-8');`;
c = c.replace(oldWrite, newWrite);

// Step 4: Remove old writeInvariantsDoc call (moved to after warnings)
c = c.replace(
  `  // Write updated INVARIANTS.md
  writeInvariantsDoc(wsRoot, newRecords);

  const coreCount`,
  `  const coreCount`,
);

// Step 5: Replace global uncovered check with per-module + add writeInvariantsDoc after
const oldUncov = `  // Uncovered core modules: core modules with zero invariant coverage
  if (coreCount === 0 && contract.coreModules.length > 0) {
    const paths = contract.coreModules.map(m => m.path).slice(0, 5).join(', ');
    warnings.push(\`\ud83d\udd34 \${contract.coreModules.length} m\u00f3dulo(s) core sin invariantes: \${paths}\`);
  }`;

const newUncov = `  // Uncovered core modules: per-module check
  for (const cm of contract.coreModules) {
    const mp = cm.path.replace(/\\\\/g, '/');
    if (!newRecords.some(r => r.tier === 'core' && r.files.some(f => f.includes(dirname(mp))))) {
      warnings.push(\`\ud83d\udd34 M\u00f3dulo core "\${mp}" sin invariantes\`);
    }
  }

  // Write updated INVARIANTS.md (after all warnings collected)
  writeInvariantsDoc(wsRoot, newRecords, warnings);`;

c = c.replace(oldUncov, newUncov);

writeFileSync("src/invariants-manager.ts", c, "utf-8");
const after = c.split("\n").length;
console.log(`Before: ${before}, After: ${after}`);
