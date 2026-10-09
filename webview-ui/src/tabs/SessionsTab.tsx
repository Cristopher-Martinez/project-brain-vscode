import { useAppState } from "../store/AppContext";
import { postMessage } from "../vscode";
import { Markdown } from "../components/Markdown";

export function SessionsTab() {
  const { state } = useAppState();

  return (
    <div>
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => postMessage({ type: "getSessionHistory" })}
          className="px-3 py-1.5 text-xs rounded bg-vsc-btn-sec-bg text-vsc-btn-sec-fg hover:opacity-80 cursor-pointer"
        >
          🔄 Load Session History
        </button>
      </div>

      {!state.sessionHistory ? (
        <div className="text-center py-10 opacity-50">
          <div className="text-3xl mb-2">🕐</div>
          <p className="text-xs">Click "Load" to view session handoff data</p>
        </div>
      ) : (
        <div className="text-xs leading-relaxed p-4 bg-vsc-header border border-vsc-border rounded-lg">
          <Markdown content={state.sessionHistory} />
        </div>
      )}
    </div>
  );
}
