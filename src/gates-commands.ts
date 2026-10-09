import * as vscode from "vscode";
import { promises as fs } from "node:fs";
import * as path from "node:path";

const GATE_LEVELS = ["deny", "warn", "off"] as const;
type GateLevel = (typeof GATE_LEVELS)[number];

interface GateMeta {
  id: string;
  label: string;
  description: string;
  defaultLevel: GateLevel;
}

/**
 * UI catalog of user-tunable quality gates. The portable engine
 * (quality-gate/config.mjs) owns the authoritative runtime defaults; this list
 * only drives the Quick Pick presentation (labels/descriptions the engine lacks).
 */
const KNOWN_GATES: GateMeta[] = [
  {
    id: "destructive-command",
    label: "Destructive command",
    description: "rm -rf, git reset --hard, DROP TABLE, and similar",
    defaultLevel: "deny",
  },
  {
    id: "secret-exposure",
    label: "Secret exposure",
    description: "API keys, tokens, private keys in written file content",
    defaultLevel: "deny",
  },
];

const LEVEL_META: Record<GateLevel, { label: string; detail: string }> = {
  deny: {
    label: "$(error) Deny",
    detail: "Hard block — the command is refused",
  },
  warn: {
    label: "$(warning) Warn",
    detail: "Allow, but surface a notice",
  },
  off: {
    label: "$(circle-slash) Off",
    detail: "Gate disabled — not evaluated",
  },
};

interface GateConfigFile {
  gates: Record<string, string>;
}

function configPath(rootPath: string): string {
  return path.join(rootPath, ".project-brain", "quality-gates.json");
}

async function readGateConfig(rootPath: string): Promise<GateConfigFile> {
  try {
    const raw = await fs.readFile(configPath(rootPath), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      "gates" in parsed &&
      typeof (parsed as { gates: unknown }).gates === "object" &&
      (parsed as { gates: unknown }).gates !== null
    ) {
      return { gates: (parsed as GateConfigFile).gates };
    }
  } catch {
    // missing or invalid → start from an empty config
  }
  return { gates: {} };
}

async function writeGateConfig(
  rootPath: string,
  config: GateConfigFile,
): Promise<void> {
  await fs.mkdir(path.join(rootPath, ".project-brain"), { recursive: true });
  await fs.writeFile(
    configPath(rootPath),
    JSON.stringify(config, null, 2) + "\n",
    "utf8",
  );
}

async function pickGate(
  config: GateConfigFile,
): Promise<{ gateId: string; label: string } | undefined> {
  const items = KNOWN_GATES.map((g) => {
    const current = config.gates[g.id] ?? g.defaultLevel;
    return {
      label: g.label,
      description: `current: ${current}`,
      detail: g.description,
      gateId: g.id,
    };
  });
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Select a quality gate to configure",
  });
  return picked ? { gateId: picked.gateId, label: picked.label } : undefined;
}

async function pickLevel(gateLabel: string): Promise<GateLevel | undefined> {
  const items = GATE_LEVELS.map((lvl) => ({
    label: LEVEL_META[lvl].label,
    detail: LEVEL_META[lvl].detail,
    level: lvl,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Set level for "${gateLabel}"`,
  });
  return picked?.level;
}

export interface GatesCommandDeps {
  resolveRoot: () => Promise<string | undefined>;
}

export function registerGatesCommands(
  context: vscode.ExtensionContext,
  deps: GatesCommandDeps,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("projectBrain.gates.toggle", async () => {
      const rootPath = await deps.resolveRoot();
      if (!rootPath) {
        vscode.window.showWarningMessage(
          "Project Brain: no workspace folder found.",
        );
        return;
      }
      const config = await readGateConfig(rootPath);
      const gate = await pickGate(config);
      if (!gate) return;
      const level = await pickLevel(gate.label);
      if (!level) return;
      config.gates[gate.gateId] = level;
      await writeGateConfig(rootPath, config);
      vscode.window.showInformationMessage(
        `Quality gate "${gate.label}" set to ${level.toUpperCase()}.`,
      );
    }),
  );
}
