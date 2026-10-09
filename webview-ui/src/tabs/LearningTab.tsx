// Self-Learning Lab — Main tab (composition only)

import { useState } from "react";
import { useAppState } from "../store/AppContext";
import { postMessage } from "../vscode";
import { AnalysisPanel } from "./LearningAnalysis";
import { ConfigSection } from "./LearningConfig";
import { RepoTable } from "./LearningRepoTable";

function AddRepoBar() {
  const [source, setSource] = useState("");

  const handleAdd = () => {
    if (!source.trim()) return;
    postMessage({ type: "sl:addRepo", source: source.trim() } as never);
    setSource("");
  };

  return (
    <div className="flex gap-2 mb-4">
      <input
        type="text"
        title="Repository source"
        value={source}
        onChange={(e) => setSource(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        placeholder="GitHub URL or local folder path..."
        className="flex-1 px-3 py-1.5 text-xs bg-vsc-input-bg border border-vsc-border rounded"
      />
      <button
        onClick={handleAdd}
        disabled={!source.trim()}
        className="px-4 py-1.5 text-xs rounded bg-vsc-accent text-white hover:opacity-80 cursor-pointer disabled:opacity-40">
        + Add Repo
      </button>
      <button
        onClick={() => postMessage({ type: "sl:getRepos" } as never)}
        className="px-3 py-1.5 text-xs rounded bg-vsc-btn-sec-bg text-vsc-btn-sec-fg hover:opacity-80 cursor-pointer">
        Refresh
      </button>
    </div>
  );
}

export function LearningTab() {
  const { state } = useAppState();
  const [analyzeRepoId, setAnalyzeRepoId] = useState<number | null>(null);

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-base font-bold mb-1">Self-Learning Lab</h2>
        <p className="text-[11px] opacity-50">
          Clone repos, vectorize with local embeddings, analyze with 10 AI
          agents. Learn from any codebase.
        </p>
      </div>

      {state.slError && (
        <div className="p-3 mb-4 bg-red-900/20 border border-red-500/30 rounded text-xs text-red-400">
          {state.slError}
        </div>
      )}

      <ConfigSection
        config={state.slConfig}
        providerStatus={state.slProviderStatus}
        onSave={(c) =>
          postMessage({ type: "sl:saveConfig", config: c } as never)
        }
      />

      <AddRepoBar />

      {analyzeRepoId !== null && (
        <AnalysisPanel
          repoId={analyzeRepoId}
          onClose={() => setAnalyzeRepoId(null)}
        />
      )}

      <RepoTable
        repos={state.slRepos}
        onAnalyze={(id) => setAnalyzeRepoId(id)}
        progress={state.slProgress}
      />
    </div>
  );
}
