import {
  COMPLEXITY_SIGNALS,
  TaskClassification,
  TaskComplexity,
  TaskType,
  TYPE_SIGNALS,
} from "./model-router-types";

export function classifyTask(
  prompt: string,
  command: string | undefined,
  log: (msg: string) => void,
): TaskClassification {
  const type = detectTaskType(prompt, command);
  const complexity = detectComplexity(prompt, command);
  const estimatedTokens = estimateTokens(prompt);

  const classification: TaskClassification = {
    type,
    complexity,
    estimatedTokens,
    requiresReasoning: ["complex", "expert"].includes(complexity),
    requiresCodeUnderstanding: [
      "code-generation",
      "code-review",
      "debugging",
      "architecture",
    ].includes(type),
  };

  log(
    `[ModelRouter] Task: type=${type}, complexity=${complexity}, tokens≈${estimatedTokens}`,
  );
  return classification;
}

function detectTaskType(prompt: string, command?: string): TaskType {
  if (command === "doc") return "documentation";
  if (command === "status") return "status";
  if (command === "search") return "simple-qa";
  if (command === "identity" || command === "soul" || command === "user") {
    return "bootstrap";
  }

  let bestType: TaskType = "simple-qa";
  let bestScore = 0;

  for (const [type, patterns] of TYPE_SIGNALS) {
    const score = patterns.filter((p) => p.test(prompt)).length;
    if (score > bestScore) {
      bestScore = score;
      bestType = type;
    }
  }

  return bestType;
}

function detectComplexity(prompt: string, command?: string): TaskComplexity {
  if (command === "status" || command === "search") return "simple";
  if (command === "doc") return "medium";

  for (const [level, patterns] of COMPLEXITY_SIGNALS) {
    if (patterns.some((p) => p.test(prompt))) return level;
  }

  const wordCount = prompt.split(/\s+/).length;
  if (wordCount > 100) return "complex";
  if (wordCount > 40) return "medium";
  if (wordCount > 15) return "simple";
  return "trivial";
}

function estimateTokens(prompt: string): number {
  return Math.ceil(prompt.length / 4);
}
