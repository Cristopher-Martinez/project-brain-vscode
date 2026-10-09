/**
 * LM Tools Registration — wires all sub-tools into the Toolbox multiplexer.
 *
 * Extracted from lm-tools.ts to respect the 400-line file limit.
 */

import * as path from "path";
import * as vscode from "vscode";
import type { AdminDB } from "./admin-db";
import { AgentIdentityManager } from "./agent-identity";
import { AutoCapture } from "./auto-capture";
import { AutoRecall } from "./auto-recall";
import { syncInvariants } from "./invariants-manager";
import { ToolboxTool } from "./lm-tools";
import { AuditClassifyTool } from "./lm-tools-audit-classify";
import { AutohydrateBypassTool } from "./lm-tools-autohydrate-bypass";
import { AutohydrateClassifyTool } from "./lm-tools-autohydrate-classify";
import { CheckpointTool } from "./lm-tools-checkpoint";
import { CommitCheckpointTool, SquashDigestTool } from "./lm-tools-commit";
import { EnrichPromptTool } from "./lm-tools-context";
import { SearchConversationsTool } from "./lm-tools-conversations";
import {
  CompleteReminderTool,
  CreateReminderTool,
  ListRemindersTool,
  SnoozeReminderTool,
} from "./lm-tools-cron";
import { DelegateTaskTool, SwarmTool } from "./lm-tools-delegation";
import { ReadAgentDiaryTool, WriteAgentDiaryTool } from "./lm-tools-diary";
import { DocumentLearningTool } from "./lm-tools-documentation";
import { FileLockTool } from "./lm-tools-file-lock";
import { MemoryHistoryTool, SearchRelationsTool } from "./lm-tools-graph";
import {
  LoopAwaitInputTool,
  LoopEndTool,
  LoopReconnectTool,
  LoopTool,
} from "./lm-tools-loop";
import { HydrateLoopContextTool } from "./lm-tools-loop-hydration";
import { LoopMailTool } from "./lm-tools-loop-mailbox";
import {
  IndexProjectTool,
  VectorizationStatusTool,
  WatchProjectTool,
} from "./lm-tools-mcp";
import {
  GetProjectContextTool,
  ListMemoryFilesTool,
  ListProjectsTool,
  WriteProjectMemoryTool,
} from "./lm-tools-memory";
import { HeartbeatTool, ReflectTool } from "./lm-tools-neuro";
import { OrchestrateTool } from "./lm-tools-orchestration-core";
import {
  OrchAwaitInputTool,
  OrchEndSessionTool,
} from "./lm-tools-orchestration-lifecycle";
import { ResolvePathTool } from "./lm-tools-path-rewriter";
import {
  registerStandaloneTools,
  type StandaloneToolRefs,
} from "./lm-tools-registration-standalone";
import { SearchMemoryTool, UnifiedSearchTool } from "./lm-tools-search";
import { ShadowTestTool } from "./lm-tools-shadow-test";
import { FindSkillTool } from "./lm-tools-skills";
import {
  StrategyCompleteTool,
  StrategyFinalizeTool,
  StrategyPickerTool,
} from "./lm-tools-strategy";
import { RememberThisTool } from "./lm-tools-tesseract";
import {
  ReadVaultEntryTool,
  WriteVaultEntryTool,
  RemoveVaultEntryTool,
} from "./lm-tools-vault";
import { initLoopEngine } from "./loop-engine";
import { MCPManager } from "./mcp-manager";
import type { MemoryFS } from "./memory-fs";
import { ModelRouter } from "./model-router";
import { OpinionBank } from "./opinion-bank";
import { OrchestrationManager } from "./orchestration-manager";
import { ReactiveRecall } from "./reactive-recall";
import { ReflectionValidator } from "./reflection-validator";
import type { SkillManager } from "./skill-manager";
import { initTestAdvice } from "./test-advice";
import { initTestClassifier } from "./test-classifier";
import { getOrDetectContract } from "./test-pipeline-contracts";

// ─────────────────────────────────────────────────────────────────────────────

/** References to LM tool instances that support post-hoc configuration. */
export interface LMToolRefs extends StandaloneToolRefs {
  toolbox: ToolboxTool;
  searchMemory: SearchMemoryTool;
  getContext: GetProjectContextTool;
}

export function registerLMTools(
  context: vscode.ExtensionContext,
  workspaceFolder: vscode.WorkspaceFolder,
  searchFn: (query: string, opts?: { category?: string; topic?: string }) => Promise<string>,
  identityManager: AgentIdentityManager,
  log: (msg: string) => void,
  modelRouter?: ModelRouter,
  mcpManager?: MCPManager,
  opinionBank?: OpinionBank,
  autoCapture?: AutoCapture,
  autoRecall?: AutoRecall,
  skillManagerRef?: { get: () => SkillManager | null },
  adminDbRef?: { get: () => AdminDB | null },
  memoryFSRef?: { get: () => MemoryFS | null },
  orchestrationManager?: OrchestrationManager,
): LMToolRefs {
  const config = vscode.workspace.getConfiguration("projectBrain");
  initLoopEngine(context);
  const memoryFolder = config.get<string>(
    "memoryFolder",
    ".project-brain/memory",
  );
  const memoryPath = path.join(workspaceFolder.uri.fsPath, memoryFolder);

  const bank = opinionBank ?? new OpinionBank(memoryPath, log);
  const capture = autoCapture ?? null;
  const recall = autoRecall ?? null;

  // Register standalone Brain tools (awaken = standalone, rest = toolbox sub-tools)
  const standalone = registerStandaloneTools({
    context,
    identityManager,
    bank,
    memoryPath,
    workspacePath: workspaceFolder.uri.fsPath,
    searchFn,
    log,
  });

  // Toolbox — all other tools
  const toolbox = new ToolboxTool();

  // Register unique Brain tools as toolbox sub-tools (no native equivalent)
  toolbox.register("command", standalone.command);
  toolbox.register("gitChanges", standalone.gitChanges);
  toolbox.register("installExtension", standalone.installExtension);

  // Core tools
  const searchMemoryTool = new SearchMemoryTool(
    searchFn,
    identityManager,
    capture,
    recall,
    log,
  );
  if (skillManagerRef) searchMemoryTool.setSkillManagerRef(skillManagerRef);
  if (adminDbRef) searchMemoryTool.setAdminDbRef(adminDbRef);
  toolbox.register("searchMemory", searchMemoryTool);
  const getContextTool = new GetProjectContextTool(workspaceFolder, log);
  toolbox.register("getContext", getContextTool);
  toolbox.register(
    "writeMemory",
    new WriteProjectMemoryTool(workspaceFolder, log, memoryFSRef),
  );
  toolbox.register("documentLearning", new DocumentLearningTool());
  toolbox.register(
    "listMemoryFiles",
    new ListMemoryFilesTool(workspaceFolder, log),
  );
  toolbox.register("listProjects", new ListProjectsTool(log));

  // Unified search (auto/quick/deep modes)
  toolbox.register(
    "search",
    new UnifiedSearchTool(searchFn, workspaceFolder, log),
  );
  // Conversation history search
  toolbox.register(
    "searchConversations",
    new SearchConversationsTool(memoryPath, log),
  );

  // Context enricher — enriches prompts with project memory, file maps, risks
  toolbox.register(
    "enrichPrompt",
    new EnrichPromptTool(workspaceFolder, context.extensionPath, log),
  );
  // Skill discovery
  const findSkillTool = new FindSkillTool(
    memoryPath,
    context.extensionPath,
    log,
    skillManagerRef,
  );
  if (adminDbRef) findSkillTool.setAdminDbRef(adminDbRef);
  toolbox.register("findSkill", findSkillTool);

  // Neuroplasticity tools
  toolbox.register("heartbeat", new HeartbeatTool(bank, capture, log));
  toolbox.register("reflect", new ReflectTool(bank, log));

  // Strategy picker (graph-ranked implementation strategies, Pro+)
  toolbox.register(
    "strategyPicker",
    new StrategyPickerTool(
      workspaceFolder,
      memoryPath,
      context.extensionPath,
      log,
    ),
  );
  toolbox.register(
    "strategyFinalize",
    new StrategyFinalizeTool(memoryPath, log),
  );
  toolbox.register(
    "strategyComplete",
    new StrategyCompleteTool(workspaceFolder.uri.fsPath, memoryPath, log),
  );

  // Cron reminder tools (Pro+)
  toolbox.register("createReminder", new CreateReminderTool(memoryPath, log));
  toolbox.register("listReminders", new ListRemindersTool(memoryPath, log));
  toolbox.register("snoozeReminder", new SnoozeReminderTool(memoryPath, log));
  toolbox.register(
    "completeReminder",
    new CompleteReminderTool(memoryPath, log),
  );

  // Tesseract — temporal self-mailbox
  toolbox.register("rememberThis", new RememberThisTool(memoryPath, log));

  // Agent diary tools — per-mode persistent learning journals
  toolbox.register("readAgentDiary", new ReadAgentDiaryTool(memoryPath, log));
  toolbox.register("writeAgentDiary", new WriteAgentDiaryTool(memoryPath, log));

  // Vault tools — secure credential storage with agent-readable instructions
  toolbox.register("readVaultEntry", new ReadVaultEntryTool(log));
  toolbox.register("writeVaultEntry", new WriteVaultEntryTool(log));
  toolbox.register("removeVaultEntry", new RemoveVaultEntryTool(log));

  // Audit classification — subagent-powered, optional bypass for audit gate
  toolbox.register("auditClassify", new AuditClassifyTool(log));
  // Autohydrate classification — LLM-powered learning detection for autohydrate gate
  toolbox.register("autohydrateClassify", new AutohydrateClassifyTool(log));
  // Autohydrate bypass — agent-accessible toggle for autohydrate gate
  toolbox.register("autohydrateBypass", new AutohydrateBypassTool(log));
  // Commit checkpoint — smart atomic commits with conventional messages
  toolbox.register("commitCheckpoint", new CommitCheckpointTool(log));
  toolbox.register("squashDigest", new SquashDigestTool(log));
  // Wire AutoCapture + ReactiveRecall
  toolbox.setAutoCapture(capture);
  const reactiveRecall = new ReactiveRecall(memoryPath, log);
  reactiveRecall.setOpinionBank(bank);
  toolbox.setReactiveRecall(reactiveRecall);

  // Wire BERT quality gate (fail-open if model unavailable)
  const validator = new ReflectionValidator(context.extensionPath, log);
  if (capture) {
    capture.setValidator(validator);
  }

  // Optional tools (require ModelRouter)
  if (modelRouter) {
    toolbox.register("delegateTask", new DelegateTaskTool(modelRouter, log));
    const swarmTool = new SwarmTool(modelRouter, log);
    if (capture) {
      swarmTool.setAutoCapture(capture);
    }
    toolbox.register("swarm", swarmTool);
    if (orchestrationManager) {
      toolbox.register(
        "orchestrate",
        new OrchestrateTool(modelRouter, orchestrationManager, log),
      );
      toolbox.register(
        "orchEndSession",
        new OrchEndSessionTool(orchestrationManager, log),
      );
      toolbox.register(
        "orchAwaitInput",
        new OrchAwaitInputTool(orchestrationManager, log),
      );
    }
    toolbox.register("loop", new LoopTool(log));
    toolbox.register("loopAwaitInput", new LoopAwaitInputTool(log));
    toolbox.register("loopEnd", new LoopEndTool(log));
    toolbox.register("loopReconnect", new LoopReconnectTool(log));
    toolbox.register("hydrateLoopContext", new HydrateLoopContextTool(log));
    toolbox.register("checkpoint", new CheckpointTool(log));
    toolbox.register("resolvePath", new ResolvePathTool(log));
    toolbox.register("fileLock", new FileLockTool(log));
    toolbox.register("shadowTest", new ShadowTestTool(log));
    toolbox.register("loopMail", new LoopMailTool(log));
    // Initialize AI test classifier with ModelRouter
    initTestClassifier(modelRouter);
    initTestAdvice(modelRouter);

    // Initialize test pipeline contract (T0) — fire-and-forget
    try {
      const contract = getOrDetectContract(workspaceFolder.uri.fsPath);
      // T1: Sync invariants after contract is ready
      if (contract) {
        try {
          syncInvariants(workspaceFolder.uri.fsPath, contract);
        } catch {
          /* non-critical */
        }
      }
    } catch {
      /* non-critical */
    }
  }

  // MCP-backed tools
  if (mcpManager) {
    toolbox.register("indexProject", new IndexProjectTool(mcpManager, log));
    toolbox.register(
      "vectorizationStatus",
      new VectorizationStatusTool(mcpManager, workspaceFolder, log),
    );
    toolbox.register(
      "watchProject",
      new WatchProjectTool(mcpManager, workspaceFolder, log),
    );
    toolbox.register(
      "searchRelations",
      new SearchRelationsTool(workspaceFolder, log),
    );
    toolbox.register(
      "memoryHistory",
      new MemoryHistoryTool(workspaceFolder, log),
    );
  }

  context.subscriptions.push(
    vscode.lm.registerTool("projectBrain_toolbox", toolbox),
  );

  log(
    `LM tools registered: awaken (standalone) + toolbox (${toolbox.availableTools.join(", ")})`,
  );

  return {
    ...standalone,
    toolbox,
    searchMemory: searchMemoryTool,
    getContext: getContextTool,
  };
}
