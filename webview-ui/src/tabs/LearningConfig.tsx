// Embedding provider config for Self-Learning tab

import { useEffect, useRef, useState } from "react";
import type { SLEmbeddingConfig, SLEmbeddingProvider } from "../types/messages";
import { SL_DEFAULT_CONFIGS } from "../types/messages-learning";
import { postMessage } from "../vscode";

export type ProviderStatusResult = {
  provider: string;
  available: boolean;
} | null;
type CheckStatus =
  | "idle"
  | "checking"
  | "available"
  | "unavailable"
  | "timeout";

const CHECK_TIMEOUT_MS = 10_000;

// ─── Provider Selector ──────────────────────────────────────────────────────

function ProviderSelector({
  provider,
  model,
  onProvider,
  onModel,
}: {
  provider: SLEmbeddingProvider;
  model: string;
  onProvider: (p: SLEmbeddingProvider) => void;
  onModel: (v: string) => void;
}) {
  const providers: SLEmbeddingProvider[] = [
    "ollama",
    "lmstudio",
    "llamafile",
    "custom",
  ];

  return (
    <>
      <div>
        <label className="text-[11px] opacity-60 block mb-1">Provider</label>
        <select
          title="Embedding provider"
          value={provider}
          onChange={(e) => onProvider(e.target.value as SLEmbeddingProvider)}
          className="w-full px-2 py-1.5 text-xs bg-vsc-input-bg border border-vsc-border rounded">
          {providers.map((p) => (
            <option key={p} value={p}>
              {p === "ollama"
                ? "Ollama"
                : p === "lmstudio"
                  ? "LM Studio"
                  : p === "llamafile"
                    ? "llamafile"
                    : "Custom"}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="text-[11px] opacity-60 block mb-1">Model</label>
        <input
          type="text"
          title="Embedding model name"
          placeholder="all-minilm"
          value={model}
          onChange={(e) => onModel(e.target.value)}
          className="w-full px-2 py-1.5 text-xs bg-vsc-input-bg border border-vsc-border rounded"
        />
      </div>
    </>
  );
}

// ─── Connection Fields ──────────────────────────────────────────────────────

function ConnectionFields({
  baseUrl,
  apiKey,
  onBaseUrl,
  onApiKey,
}: {
  baseUrl: string;
  apiKey: string;
  onBaseUrl: (v: string) => void;
  onApiKey: (v: string) => void;
}) {
  return (
    <>
      <div className="col-span-2">
        <label className="text-[11px] opacity-60 block mb-1">Base URL</label>
        <input
          type="text"
          title="Embedding server URL"
          placeholder="http://localhost:11434/api/embed"
          value={baseUrl}
          onChange={(e) => onBaseUrl(e.target.value)}
          className="w-full px-2 py-1.5 text-xs bg-vsc-input-bg border border-vsc-border rounded"
        />
      </div>
      <div>
        <label className="text-[11px] opacity-60 block mb-1">API Key</label>
        <input
          type="text"
          title="API key (optional)"
          placeholder="optional"
          value={apiKey}
          onChange={(e) => onApiKey(e.target.value)}
          className="w-full px-2 py-1.5 text-xs bg-vsc-input-bg border border-vsc-border rounded"
        />
      </div>
    </>
  );
}

// ─── Config State Hook ──────────────────────────────────────────────────────

function useConfigState(
  config: SLEmbeddingConfig | null,
  providerStatus: ProviderStatusResult,
) {
  const defaults = SL_DEFAULT_CONFIGS.ollama;
  const [provider, setProvider] = useState<SLEmbeddingProvider>(
    config?.provider ?? "ollama",
  );
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? defaults.baseUrl);
  const [model, setModel] = useState(config?.model ?? defaults.model);
  const [apiKey, setApiKey] = useState(config?.apiKey ?? defaults.apiKey);
  const [checkStatus, setCheckStatus] = useState<CheckStatus>("idle");
  const [validationError, setValidationError] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  // React to real provider status response
  useEffect(() => {
    if (providerStatus && checkStatus === "checking") {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      setCheckStatus(providerStatus.available ? "available" : "unavailable");
    }
  }, [providerStatus, checkStatus]);

  const handleProviderChange = (p: SLEmbeddingProvider) => {
    setProvider(p);
    setCheckStatus("idle");
    setValidationError(null);
    if (p !== "custom" && p in SL_DEFAULT_CONFIGS) {
      const def = SL_DEFAULT_CONFIGS[p];
      setBaseUrl(def.baseUrl);
      setModel(def.model);
      setApiKey(def.apiKey);
    }
  };

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCheck = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setCheckStatus("checking");
    postMessage({ type: "sl:checkProvider", provider } as never);
    timeoutRef.current = setTimeout(
      () => setCheckStatus("timeout"),
      CHECK_TIMEOUT_MS,
    );
  };

  const handleSave = (onSave: (c: SLEmbeddingConfig) => void) => {
    if (!baseUrl.trim()) {
      setValidationError("Base URL is required");
      return;
    }
    if (!model.trim()) {
      setValidationError("Model name is required");
      return;
    }
    try {
      new URL(baseUrl);
    } catch {
      setValidationError("Invalid URL format");
      return;
    }
    setValidationError(null);
    onSave({ provider, baseUrl, model, apiKey });
  };

  return {
    provider,
    baseUrl,
    model,
    apiKey,
    checkStatus,
    validationError,
    setModel: (v: string) => {
      setModel(v);
      setValidationError(null);
    },
    setBaseUrl: (v: string) => {
      setBaseUrl(v);
      setValidationError(null);
    },
    setApiKey,
    handleProviderChange,
    handleCheck,
    handleSave,
  };
}

// ─── Config Section ─────────────────────────────────────────────────────────

export function ConfigSection({
  config,
  providerStatus,
  onSave,
}: {
  config: SLEmbeddingConfig | null;
  providerStatus: ProviderStatusResult;
  onSave: (c: SLEmbeddingConfig) => void;
}) {
  const {
    provider,
    baseUrl,
    model,
    apiKey,
    checkStatus,
    validationError,
    setModel,
    setBaseUrl,
    setApiKey,
    handleProviderChange,
    handleCheck,
    handleSave,
  } = useConfigState(config, providerStatus);

  return (
    <div className="p-4 bg-vsc-header border border-vsc-border rounded-lg mb-4">
      <h3 className="text-sm font-semibold mb-3 opacity-80">
        Embedding Provider (Local)
      </h3>
      <p className="text-[11px] opacity-50 mb-3">
        Necesitas un servidor de embeddings local corriendo (Ollama, LM Studio o
        llamafile) para vectorizar repositorios externos.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <ProviderSelector
          provider={provider}
          model={model}
          onProvider={handleProviderChange}
          onModel={setModel}
        />
        <ConnectionFields
          baseUrl={baseUrl}
          apiKey={apiKey}
          onBaseUrl={setBaseUrl}
          onApiKey={setApiKey}
        />
      </div>
      {validationError && (
        <p className="text-xs text-red-400 mt-2">{validationError}</p>
      )}
      <div className="flex items-center gap-2 mt-3">
        <button
          onClick={handleCheck}
          disabled={checkStatus === "checking"}
          className="px-3 py-1.5 text-xs rounded bg-vsc-btn-sec-bg text-vsc-btn-sec-fg hover:opacity-80 cursor-pointer disabled:opacity-40">
          {checkStatus === "checking" ? "Checking..." : "Check Connection"}
        </button>
        <CheckStatusIndicator status={checkStatus} />
        <button
          onClick={() => handleSave(onSave)}
          className="px-3 py-1.5 text-xs rounded bg-vsc-accent text-white hover:opacity-80 cursor-pointer">
          Save
        </button>
      </div>
    </div>
  );
}

function CheckStatusIndicator({ status }: { status: CheckStatus }) {
  if (status === "idle" || status === "checking") return null;
  const styles: Record<string, { cls: string; text: string }> = {
    available: { cls: "text-green-400", text: "Connected" },
    unavailable: { cls: "text-red-400", text: "Not available" },
    timeout: { cls: "text-yellow-400", text: "Timeout — no response" },
  };
  const s = styles[status];
  if (!s) return null;
  return <span className={`text-xs ${s.cls}`}>{s.text}</span>;
}
