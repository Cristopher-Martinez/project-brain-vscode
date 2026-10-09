export interface TestAdviceEntry {
  file: string;
  relativePath?: string;
  diffFingerprint?: string;
  needsTests: boolean;
  reason: string;
  confidence: number;
  acceptanceCriteria: string[];
  suggestedTestPath?: string;
  draftTest?: string;
  autopilotTargetPath?: string;
  autopilotDraftPath?: string;
  autopilotRunCommand?: string;
  autopilotShadowCommand?: string;
  autopilotApplyCommand?: string;
  recommendationBand?: "advisory" | "draft-only" | "autopilot-safe";
  validation?: {
    syntaxOk: boolean;
    targetPathOk: boolean;
    runCommandOk: boolean;
    policyLabel?: string;
    requiredSuccesses?: number;
    notes: string[];
  };
  timestamp: number;
  modelId?: string;
}

export interface TestAdviceCache {
  [fileKey: string]: TestAdviceEntry;
}