import { MergeGate } from "./MergeGate";
import type { BranchIsolationInfo, BranchAuditResult, AuditTrend, AuditHistoryEntry } from "../../types/messages";

interface BranchAuditEntry {
  result: BranchAuditResult;
  trend?: AuditTrend;
  history?: AuditHistoryEntry[];
}

interface PendingBranchesProps {
  branches: BranchIsolationInfo[];
  audits?: Record<string, BranchAuditEntry>;
  checkedOutId?: string;
  onRequestAudit?: (sessionId: string) => void;
}

export function PendingBranches({ branches, audits, checkedOutId, onRequestAudit }: PendingBranchesProps) {
  if (branches.length === 0) return null;

  return (
    <div className="mb-4">
      <h4 className="text-xs font-semibold mb-2 opacity-70">
        🌿 Pending Branches ({branches.length})
      </h4>
      {branches.map((b) => {
        const auditEntry = audits?.[b.sessionId];
        return (
          <MergeGate
            key={b.sessionId}
            branch={b}
            audit={auditEntry?.result}
            trend={auditEntry?.trend}
            history={auditEntry?.history}
            checkedOut={checkedOutId === b.sessionId}
            onRequestAudit={onRequestAudit}
          />
        );
      })}
    </div>
  );
}
