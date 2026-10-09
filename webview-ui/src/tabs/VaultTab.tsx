import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppState } from "../store/AppContext";
import { postMessage } from "../vscode";

// ─── Types ──────────────────────────────────────────────────────────────────

interface VaultEntry {
  label: string;
  instructions: string;
  secrets: Record<string, string>;
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function VaultTab() {
  const { state } = useAppState();
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [exists, setExists] = useState(false);
  const [editingEntry, setEditingEntry] = useState<VaultEntry | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Listen for vault data from extension
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === "vault:entries") {
        setEntries(msg.data.entries ?? []);
        setExists(msg.data.exists ?? false);
      }
      if (msg.type === "vault:error") {
        alert(`⚠️ Vault Error: ${msg.data?.message ?? "Unknown error"}`);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // Request vault data on mount
  useEffect(() => {
    postMessage({ type: "vault:getEntries" } as never);
  }, []);

  const handleInit = () => {
    postMessage({ type: "vault:init" } as never);
  };

  const handleNew = () => {
    setEditingEntry({ label: "", instructions: "", secrets: {} });
    setIsNew(true);
  };

  const handleEdit = (entry: VaultEntry) => {
    setEditingEntry({ ...entry, secrets: { ...entry.secrets } });
    setIsNew(false);
  };

  const handleSave = (entry: VaultEntry) => {
    postMessage({ type: "vault:upsert", entry } as never);
    setEditingEntry(null);
    setIsNew(false);
  };

  const handleDelete = (label: string) => {
    postMessage({ type: "vault:remove", label } as never);
    setConfirmDelete(null);
  };

  const handleOpenFile = () => {
    postMessage({ type: "vault:openFile" } as never);
  };

  // ─── Not Initialized ───────────────────────────────────────────────

  if (!exists) {
    return (
      <div className="text-center py-16">
        <div className="text-5xl mb-4">🔐</div>
        <h3 className="text-base font-bold mb-2">Vault no inicializado</h3>
        <p className="text-xs opacity-50 max-w-md mx-auto mb-6">
          El Vault es un almacén seguro de credenciales con instrucciones para
          agentes. Las credenciales se guardan localmente en{" "}
          <code>.project-brain/vault/project.brain.vault.env</code> y se
          auto-excluyen del repositorio.
        </p>
        <button
          onClick={handleInit}
          className="px-4 py-2 bg-vsc-button text-vsc-button-fg rounded hover:bg-vsc-button-hover cursor-pointer transition-colors">
          🔐 Inicializar Vault
        </button>
      </div>
    );
  }

  // ─── Editor Modal ─────────────────────────────────────────────────

  if (editingEntry) {
    return (
      <VaultEntryEditor
        entry={editingEntry}
        isNew={isNew}
        onSave={handleSave}
        onCancel={() => {
          setEditingEntry(null);
          setIsNew(false);
        }}
      />
    );
  }

  // ─── Main List ────────────────────────────────────────────────────

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-bold">🔐 Vault</h3>
          <p className="text-[11px] opacity-40 mt-0.5">
            Credenciales seguras con instrucciones para agentes AI
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleOpenFile}
            className="px-3 py-1.5 text-[11px] rounded border border-vsc-border hover:bg-vsc-hover cursor-pointer transition-colors"
            title="Abrir archivo vault.env en el editor">
            📄 Abrir archivo
          </button>
          <button
            onClick={handleNew}
            className="px-3 py-1.5 text-[11px] rounded bg-vsc-button text-vsc-button-fg hover:bg-vsc-button-hover cursor-pointer transition-colors">
            + Nueva entrada
          </button>
        </div>
      </div>

      {/* Security Notice */}
      <div className="mb-4 p-3 rounded-lg border border-yellow-500/30 bg-yellow-500/5">
        <div className="flex items-start gap-2">
          <span className="text-sm">⚠️</span>
          <div className="text-[11px] opacity-70">
            <strong>Seguridad:</strong> Este archivo está auto-excluido de git.
            Los agentes ven las <em>instrucciones</em> y <em>nombres de keys</em>
            {" "}en su contexto, pero solo acceden a los valores reales cuando
            los necesitan vía herramientas.
          </div>
        </div>
      </div>

      {/* Empty State */}
      {entries.length === 0 && (
        <div className="text-center py-12 opacity-50">
          <div className="text-3xl mb-2">🗝️</div>
          <p className="text-xs">No hay entradas en el vault</p>
          <p className="text-[11px] mt-1 opacity-60">
            Agrega credenciales, tokens, rutas SSH y más
          </p>
        </div>
      )}

      {/* Entry Cards */}
      {entries.map((entry) => (
        <VaultEntryCard
          key={entry.label}
          entry={entry}
          onEdit={() => handleEdit(entry)}
          onDelete={() => setConfirmDelete(entry.label)}
        />
      ))}

      {/* Delete Confirmation */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-vsc-bg border border-vsc-border rounded-lg p-6 max-w-sm">
            <h4 className="text-sm font-bold mb-2">
              Eliminar &quot;{confirmDelete}&quot;?
            </h4>
            <p className="text-[11px] opacity-60 mb-4">
              Esta acción no se puede deshacer. Las credenciales se perderán.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmDelete(null)}
                className="px-3 py-1.5 text-xs rounded border border-vsc-border hover:bg-vsc-hover cursor-pointer">
                Cancelar
              </button>
              <button
                onClick={() => handleDelete(confirmDelete)}
                className="px-3 py-1.5 text-xs rounded bg-red-600 text-white hover:bg-red-700 cursor-pointer">
                Eliminar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Entry Card ─────────────────────────────────────────────────────────────

function VaultEntryCard({
  entry,
  onEdit,
  onDelete,
}: {
  entry: VaultEntry;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const keyCount = Object.keys(entry.secrets).length;
  const [showKeys, setShowKeys] = useState(false);

  return (
    <div className="mb-3 p-4 rounded-lg border border-vsc-border bg-vsc-header/50 hover:bg-vsc-hover transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm">🔑</span>
            <span className="text-xs font-bold">{entry.label}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-vsc-accent/20 text-vsc-accent">
              {keyCount} {keyCount === 1 ? "key" : "keys"}
            </span>
          </div>
          {entry.instructions && (
            <p className="text-[11px] opacity-60 ml-6 mt-1 line-clamp-2">
              {entry.instructions}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            onClick={() => setShowKeys(!showKeys)}
            className="px-2 py-1 text-[10px] rounded border border-vsc-border hover:bg-vsc-hover cursor-pointer transition-colors"
            title={showKeys ? "Ocultar keys" : "Ver keys"}>
            {showKeys ? "🙈" : "👁️"}
          </button>
          <button
            onClick={onEdit}
            className="px-2 py-1 text-[10px] rounded border border-blue-500/40 text-blue-400 hover:bg-blue-500/10 cursor-pointer transition-colors"
            title="Editar">
            ✏️
          </button>
          <button
            onClick={onDelete}
            className="px-2 py-1 text-[10px] rounded border border-red-500/40 text-red-400 hover:bg-red-500/10 cursor-pointer transition-colors opacity-60 hover:opacity-100"
            title="Eliminar">
            🗑️
          </button>
        </div>
      </div>

      {/* Expandable key list */}
      {showKeys && (
        <div className="mt-3 ml-6 p-2 rounded bg-vsc-bg border border-vsc-border/50">
          {Object.entries(entry.secrets).map(([key, value]) => (
            <div
              key={key}
              className="flex items-center gap-2 py-1 text-[11px] font-mono">
              <span className="text-vsc-accent font-semibold">{key}</span>
              <span className="opacity-30">=</span>
              <MaskedValue value={value} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Masked Value ───────────────────────────────────────────────────────────

function MaskedValue({ value }: { value: string }) {
  const [revealed, setRevealed] = useState(false);

  const masked = useMemo(() => {
    if (value.length <= 4) return "••••";
    return value.slice(0, 2) + "•".repeat(Math.min(value.length - 4, 12)) + value.slice(-2);
  }, [value]);

  return (
    <span className="flex items-center gap-1">
      <span className="opacity-60">{revealed ? value : masked}</span>
      <button
        onClick={() => setRevealed(!revealed)}
        className="text-[9px] opacity-40 hover:opacity-80 cursor-pointer"
        title={revealed ? "Ocultar" : "Revelar"}>
        {revealed ? "🙈" : "👁️"}
      </button>
    </span>
  );
}

// ─── Entry Editor ───────────────────────────────────────────────────────────

function VaultEntryEditor({
  entry,
  isNew,
  onSave,
  onCancel,
}: {
  entry: VaultEntry;
  isNew: boolean;
  onSave: (entry: VaultEntry) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(entry.label);
  const [instructions, setInstructions] = useState(entry.instructions);
  const [secrets, setSecrets] = useState<Array<{ key: string; value: string }>>(
    Object.entries(entry.secrets).map(([key, value]) => ({ key, value })),
  );

  const addSecret = () => {
    setSecrets([...secrets, { key: "", value: "" }]);
  };

  const removeSecret = (idx: number) => {
    setSecrets(secrets.filter((_, i) => i !== idx));
  };

  const updateSecret = (
    idx: number,
    field: "key" | "value",
    val: string,
  ) => {
    const updated = [...secrets];
    updated[idx] = { ...updated[idx], [field]: val };
    setSecrets(updated);
  };

  const handleSave = () => {
    if (!label.trim()) return;
    const secretsObj: Record<string, string> = {};
    for (const s of secrets) {
      if (s.key.trim()) {
        secretsObj[s.key.trim()] = s.value;
      }
    }
    onSave({ label: label.trim(), instructions: instructions.trim(), secrets: secretsObj });
  };

  const canSave = label.trim().length > 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-bold">
          {isNew ? "🔑 Nueva entrada" : `✏️ Editar: ${entry.label}`}
        </h3>
        <button
          onClick={onCancel}
          className="px-3 py-1 text-xs rounded border border-vsc-border hover:bg-vsc-hover cursor-pointer">
          ← Volver
        </button>
      </div>

      {/* Label */}
      <div className="mb-4">
        <label className="block text-xs font-medium mb-1 opacity-80">
          Etiqueta
        </label>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Ej: Production Server, AWS Credentials..."
          disabled={!isNew}
          className="w-full px-3 py-2 text-sm bg-vsc-input border border-vsc-border rounded focus:outline-none focus:border-vsc-focus disabled:opacity-50"
        />
      </div>

      {/* Instructions */}
      <div className="mb-4">
        <label className="block text-xs font-medium mb-1 opacity-80">
          Instrucciones para agentes
        </label>
        <p className="text-[10px] opacity-40 mb-2">
          Explica cuándo y cómo usar estas credenciales. Los agentes verán esto
          en su contexto.
        </p>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Ej: Usa estas credenciales para conectarte al servidor de producción vía SSH. Solo usar cuando se necesite deployar o debuggear issues en prod."
          rows={3}
          className="w-full px-3 py-2 text-sm bg-vsc-input border border-vsc-border rounded focus:outline-none focus:border-vsc-focus resize-y"
        />
      </div>

      {/* Secrets */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs font-medium opacity-80">
            Credenciales (key=value)
          </label>
          <button
            onClick={addSecret}
            className="px-2 py-1 text-[10px] rounded bg-vsc-accent/20 text-vsc-accent hover:bg-vsc-accent/30 cursor-pointer transition-colors">
            + Agregar key
          </button>
        </div>
        {secrets.length === 0 && (
          <p className="text-[11px] opacity-40 py-2">
            No hay credenciales todavía. Haz click en &quot;+ Agregar key&quot;.
          </p>
        )}
        {secrets.map((s, idx) => (
          <div key={idx} className="flex items-center gap-2 mb-2">
            <input
              type="text"
              value={s.key}
              onChange={(e) => updateSecret(idx, "key", e.target.value)}
              placeholder="KEY_NAME"
              className="w-1/3 px-2 py-1.5 text-xs font-mono bg-vsc-input border border-vsc-border rounded focus:outline-none focus:border-vsc-focus"
            />
            <span className="opacity-30">=</span>
            <input
              type="password"
              value={s.value}
              onChange={(e) => updateSecret(idx, "value", e.target.value)}
              placeholder="value"
              className="flex-1 px-2 py-1.5 text-xs font-mono bg-vsc-input border border-vsc-border rounded focus:outline-none focus:border-vsc-focus"
            />
            <button
              onClick={() => removeSecret(idx)}
              className="px-1.5 py-1 text-[10px] rounded border border-red-500/40 text-red-400 hover:bg-red-500/10 cursor-pointer"
              title="Eliminar key">
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex gap-2 justify-end pt-2 border-t border-vsc-border">
        <button
          onClick={onCancel}
          className="px-4 py-2 text-xs rounded border border-vsc-border hover:bg-vsc-hover cursor-pointer">
          Cancelar
        </button>
        <button
          onClick={handleSave}
          disabled={!canSave}
          className={`px-4 py-2 text-xs rounded transition-colors ${
            canSave
              ? "bg-vsc-button text-vsc-button-fg hover:bg-vsc-button-hover cursor-pointer"
              : "bg-vsc-header text-vsc-fg opacity-40 cursor-not-allowed"
          }`}>
          {isNew ? "Crear" : "Guardar"}
        </button>
      </div>
    </div>
  );
}
