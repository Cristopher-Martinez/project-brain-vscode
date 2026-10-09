/**
 * bridge-memory-introspection -- Detects memory introspection queries
 * and builds a formatted dump of all PM memory sources for debugging.
 */

import { log } from "./logger";
import type {
  SessionBitacora,
  BridgeTaskMemoryData,
} from "./auto-loop-bridge-types";

// -- Detection --

const MEMORY_PATTERNS = [
  /\b(memoria|memory)\b.*\b(estado|status|registros|records|dump|contenido|contents?)\b/i,
  /\b(ultimos|latest|recent)\b.*\b(registros|entries|records|memoria)\b/i,
  /\b(bitacora|bitacora|journal|log)\b.*\b(entries|entradas|registros|show|mostrar|ver)\b/i,
  /\b(que|what).*(sabes|tienes|hay|know|have).*(memoria|memory|bitacora|context)\b/i,
  /\b(debug|debuguear|diagnostico|diagnostic)\b.*\b(memoria|memory)\b/i,
  /\b(largo|corto|short|long)\s*(plazo|term)\b.*\b(memoria|memory)\b/i,
  /\bmemoria\b.*\b(largo|corto)\b.*\bplazo\b/i,
  /\b(introspect|introspection|introspecci)\b/i,
  /\bque\s+(recuerdas|sabes)\b/i,
  /\bwhat\s+do\s+you\s+(remember|know)\b/i,
  /\b(show|mostrar|ver|dame)\b.*\b(memoria|memory|context|contexto)\b/i,
];

/** Check if a user message is asking about PM memory state. */
export function isMemoryIntrospectionQuery(text: string): boolean {
  return MEMORY_PATTERNS.some(p => p.test(text));
}

// -- Dump Builder --

export interface MemoryDumpInput {
  bitacora: SessionBitacora | null;
  taskMemory: BridgeTaskMemoryData;
  projectMemoryContext: string;
  chatHistoryCount: number;
  repoRoot: string;
}

/**
 * Build a formatted memory dump for PM introspection responses.
 * This gives the PM detailed knowledge of its own memory state
 * so it can answer debugging questions accurately.
 */
export function buildMemoryDump(input: MemoryDumpInput): string {
  const sections: string[] = ["## PM Memory State (Introspection)"];

  // 1. Bitacora (short-term session memory)
  sections.push("### Bitacora (Short-Term Session Memory)");
  if (input.bitacora && input.bitacora.entries.length > 0) {
    sections.push(`Entries: ${input.bitacora.entries.length} | MaxChars: ${input.bitacora.maxChars}`);
    const recent = input.bitacora.entries.slice(-10);
    for (const e of recent) {
      sections.push(`- [${e.type}] T${e.turn}: ${e.text}`);
    }
    if (input.bitacora.entries.length > 10) {
      sections.push(`  ... and ${input.bitacora.entries.length - 10} older entries`);
    }
  } else {
    sections.push("(empty - no entries yet)");
  }

  // 2. Task Memory (decisions, constraints, objective)
  sections.push("### Task Memory (Mid-Term)");
  sections.push(`Objective: ${input.taskMemory.objective}`);
  const decisions = input.taskMemory.approvedDecisions ?? [];
  sections.push(`Approved Decisions: ${decisions.length}`);
  for (const d of decisions.slice(-5)) {
    sections.push(`- ${d.summary ?? JSON.stringify(d).slice(0, 150)}`);
  }
  const rejected = input.taskMemory.rejectedSuggestions ?? [];
  if (rejected.length > 0) {
    sections.push(`Rejected Suggestions: ${rejected.length}`);
    for (const r of rejected.slice(-3)) { sections.push(`- ${r.slice(0, 100)}`); }
  }
  if (input.taskMemory.businessContext) {
    sections.push(`Business Context: ${input.taskMemory.businessContext.slice(0, 200)}`);
  }

  // 3. Project Memory (long-term)
  sections.push("### Project Memory (Long-Term)");
  if (input.projectMemoryContext) {
    sections.push(`Loaded: ${input.projectMemoryContext.length} chars`);
    sections.push(input.projectMemoryContext.slice(0, 500));
  } else {
    sections.push("(not loaded)");
  }

  // 4. Chat History Window
  sections.push("### Chat History Window");
  sections.push(`Messages in window: ${input.chatHistoryCount}`);

  const dump = sections.join("\n");
  log(`[MemoryIntrospection] Built dump: ${dump.length} chars`);
  return dump;
}
