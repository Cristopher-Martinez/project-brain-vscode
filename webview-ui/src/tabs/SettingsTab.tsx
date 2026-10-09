import { useCallback, useState } from "react";
import { useAppState } from "../store/AppContext";
import { postMessage } from "../vscode";

export function SettingsTab() {
  const { state } = useAppState();
  const { agentEmoji, agentName, agentCreature } = state.stats;
  const [localMaxCycles, setLocalMaxCycles] = useState<number | null>(null);

  const displayValue = localMaxCycles ?? state.loopMaxCyclesDefault;

  const handleMaxCyclesChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = parseInt(e.target.value, 10);
      if (!isNaN(val)) {
        setLocalMaxCycles(Math.max(3, Math.min(100, val)));
      }
    },
    [],
  );

  const handleMaxCyclesSave = useCallback(() => {
    if (
      localMaxCycles !== null &&
      localMaxCycles !== state.loopMaxCyclesDefault
    ) {
      postMessage({
        type: "setLoopMaxCyclesDefault",
        maxCycles: localMaxCycles,
      });
      setLocalMaxCycles(null);
    }
  }, [localMaxCycles, state.loopMaxCyclesDefault]);

  const isDirty =
    localMaxCycles !== null && localMaxCycles !== state.loopMaxCyclesDefault;

  return (
    <div>
      {/* Agent Card */}
      <div className="flex items-center gap-4 p-4 bg-vsc-header border border-vsc-border rounded-lg mb-6">
        <span className="text-[42px]">{agentEmoji}</span>
        <div>
          <h3 className="text-base font-bold">{agentName}</h3>
          <p className="text-xs opacity-60">{agentCreature}</p>
        </div>
      </div>

      {/* Loop Configuration */}
      <h3 className="text-sm font-semibold mb-3 opacity-80">
        🔄 Loop Configuration
      </h3>
      <div className="p-4 bg-vsc-header border border-vsc-border rounded-lg mb-6">
        <label className="block text-xs font-medium mb-1 opacity-80">
          Max iterations (default)
        </label>
        <p className="text-[11px] opacity-50 mb-3">
          Número máximo de ciclos antes de que un loop migre automáticamente su
          contexto. Rango: 3–100.
        </p>
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={3}
            max={100}
            value={displayValue}
            onChange={handleMaxCyclesChange}
            className="w-20 px-2 py-1 text-sm bg-vsc-input border border-vsc-border rounded focus:outline-none focus:border-vsc-focus"
          />
          <button
            onClick={handleMaxCyclesSave}
            disabled={!isDirty}
            className={`px-3 py-1 text-xs rounded transition-colors ${
              isDirty
                ? "bg-vsc-button text-vsc-button-fg hover:bg-vsc-button-hover cursor-pointer"
                : "bg-vsc-header text-vsc-fg opacity-40 cursor-not-allowed"
            }`}>
            Guardar
          </button>
          {isDirty && (
            <span className="text-[11px] opacity-50">
              Actual: {state.loopMaxCyclesDefault}
            </span>
          )}
        </div>
      </div>

      <h3 className="text-sm font-semibold mb-2 opacity-80">About Brain HQ</h3>
      <p className="text-xs opacity-60 leading-relaxed py-3">
        Brain HQ is the visual command center for Project Brain.
        <br />
        Use <strong>@brain</strong> in Copilot Chat for natural language
        interaction.
        <br />
        Use <strong>Brain HQ</strong> for visual monitoring, quick actions, and
        memory browsing.
      </p>

      <h3 className="text-sm font-semibold mb-2 mt-4 opacity-80">
        Coming Soon
      </h3>
      <div className="opacity-40 py-3 space-y-1 text-xs">
        <p>🎨 Agent Identity Editor</p>
        <p>📊 Token Cost Tracker</p>
        <p>🔧 Model Router Preferences</p>
        <p>📋 Swarm History & Replay</p>
      </div>
    </div>
  );
}
