import { useState, useRef } from "react";
import { postMessage } from "../../vscode";
import type { AvailableModel } from "../../types/messages";
import type { TeamSlot } from "../../tabs/OrchestrationTab";

interface TeamRosterProps {
  slots: TeamSlot[];
  models: AvailableModel[];
  allModels: AvailableModel[];
  enabledModelIds: string[];
  disabled: boolean;
  onRemoveSlot: (slotId: string) => void;
  onReorder: (fromIdx: number, toIdx: number) => void;
}

function ModelManager({ allModels, enabledModelIds }: { allModels: AvailableModel[]; enabledModelIds: string[] }) {
  const [visible, setVisible] = useState(false);
  const allEnabled = enabledModelIds.length === 0;
  const activeCount = allEnabled ? allModels.length : enabledModelIds.length;

  return (
    <div className="mb-2">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setVisible(!visible)}
          className="text-[11px] px-2.5 py-0.5 rounded bg-vsc-btn-sec-bg text-vsc-btn-sec-fg cursor-pointer"
        >
          ⚙️ Models <span className="opacity-60">{activeCount}/{allModels.length}</span>
        </button>
        <button
          onClick={() => postMessage({ type: "enableAllModels" })}
          className="text-[10px] px-2 py-0.5 opacity-50 rounded bg-vsc-btn-sec-bg text-vsc-btn-sec-fg cursor-pointer"
        >
          Reset (all)
        </button>
      </div>
      {visible && (
        <div className="mt-2 p-2 bg-vsc-bg border border-vsc-border rounded-md max-h-48 overflow-y-auto">
          {allModels.length === 0 ? (
            <div className="opacity-40 p-2 text-xs">No models discovered</div>
          ) : (
            allModels.map(m => {
              const isOn = allEnabled || enabledModelIds.includes(m.id);
              return (
                <label
                  key={m.id}
                  className={`flex items-center gap-2 py-1 px-2 rounded cursor-pointer text-xs ${isOn ? "" : "opacity-45"}`}
                >
                  <input
                    type="checkbox"
                    checked={isOn}
                    onChange={() => postMessage({ type: "toggleModel", modelId: m.id })}
                    className="cursor-pointer"
                  />
                  <span className="flex-1">{m.vendor} / {m.family}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded bg-vsc-header`}>{m.tier}</span>
                </label>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

export function TeamRoster({ slots, models, allModels, enabledModelIds, disabled, onRemoveSlot, onReorder }: TeamRosterProps) {
  const dragIdx = useRef(-1);

  const handleDragStart = (idx: number) => { dragIdx.current = idx; };
  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); };
  const handleDrop = (dropIdx: number) => {
    if (dragIdx.current >= 0 && dragIdx.current !== dropIdx) {
      onReorder(dragIdx.current, dropIdx);
    }
    dragIdx.current = -1;
  };

  return (
    <div>
      <ModelManager allModels={allModels} enabledModelIds={enabledModelIds} />

      {slots.length === 0 ? (
        <div className="opacity-40 p-2 text-xs">Select agents from the marketplace above</div>
      ) : (
        <div className="space-y-1">
          {slots.map((slot, idx) => (
            <div
              key={slot.slotId}
              draggable={!disabled}
              onDragStart={() => handleDragStart(idx)}
              onDragOver={handleDragOver}
              onDrop={() => handleDrop(idx)}
              className="flex items-center gap-2 p-2 bg-vsc-header border border-vsc-border rounded-md text-xs cursor-grab"
            >
              <span className="opacity-30">⠿</span>
              <span>{slot.agent.icon}</span>
              <span className="font-medium">{slot.agent.name}</span>
              <select
                data-slot={slot.slotId}
                defaultValue=""
                className="flex-1 text-[11px] p-1 rounded border border-vsc-border bg-vsc-bg text-vsc-fg"
              >
                {models.map(m => (
                  <option key={m.id} value={m.id} data-tier={m.tier}>
                    {m.vendor} / {m.family} [{m.tier}]
                  </option>
                ))}
              </select>
              {!disabled && (
                <span
                  onClick={() => onRemoveSlot(slot.slotId)}
                  className="opacity-40 hover:opacity-100 cursor-pointer"
                >
                  ✕
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
