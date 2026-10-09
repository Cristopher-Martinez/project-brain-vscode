import { useCallback, useEffect, useRef, useState } from "react";
import type { EnrichResultPayload, LoopUiState } from "../../types/messages";
import { postMessage } from "../../vscode";
import { Markdown } from "../Markdown";
import { EnrichPreview } from "./EnrichPreview";

/** Max images per feedback */
const MAX_IMAGES = 5;
/** Max dimension (width or height) for resize */
const MAX_DIMENSION = 1280;
/** JPEG quality for compressed output */
const JPEG_QUALITY = 0.8;

function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Resize an image via canvas if it exceeds MAX_DIMENSION */
function compressImage(dataUri: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const { width, height } = img;
      if (width <= MAX_DIMENSION && height <= MAX_DIMENSION) {
        resolve(dataUri);
        return;
      }
      const scale = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(dataUri);
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const compressed = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
      resolve(compressed);
    };
    img.onerror = () => resolve(dataUri);
    img.src = dataUri;
  });
}

function isImageType(type: string): boolean {
  return /^image\/(png|jpe?g|gif|webp)$/.test(type);
}

export function FeedbackPanel({
  session,
  globalMaxCycles,
}: {
  session: LoopUiState;
  globalMaxCycles?: number;
}) {
  const feedbackRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sent, setSent] = useState(false);
  const [images, setImages] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [copied, setCopied] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [commitBypass, setCommitBypass] = useState(
    session.commitBypass ?? false,
  );
  const [auditBypass, setAuditBypass] = useState(session.auditBypass ?? false);
  const [editingMaxCycles, setEditingMaxCycles] = useState(false);
  const [editValue, setEditValue] = useState("");
  const maxCyclesInputRef = useRef<HTMLInputElement>(null);
  const [enrichEnabled, setEnrichEnabled] = useState(false);
  const [enrichLoading, setEnrichLoading] = useState(false);
  const [enrichResult, setEnrichResult] = useState<EnrichResultPayload | null>(null);

  // Listen for enricher messages
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === "enrichResult" && msg.source === "feedback") {
        setEnrichResult(msg.result);
        setEnrichLoading(false);
      } else if (msg.type === "enrichLoading") {
        setEnrichLoading(msg.loading);
      } else if (msg.type === "enrichError") {
        setEnrichLoading(false);
        setEnrichResult(null);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  useEffect(() => {
    if (session.awaitingFeedback && session.pendingSynthesis) {
      panelRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [session.awaitingFeedback, session.pendingSynthesis]);

  useEffect(() => {
    setCommitBypass(session.commitBypass ?? false);
  }, [session.commitBypass]);

  useEffect(() => {
    setAuditBypass(session.auditBypass ?? false);
  }, [session.auditBypass]);

  // Focus input when editing maxCycles
  useEffect(() => {
    if (editingMaxCycles && maxCyclesInputRef.current) {
      maxCyclesInputRef.current.focus();
      maxCyclesInputRef.current.select();
    }
  }, [editingMaxCycles]);

  const toggleBypass = useCallback(() => {
    const next = !commitBypass;
    setCommitBypass(next);
    if (session.sessionId) {
      postMessage({
        type: "toggleCommitBypass",
        sessionId: session.sessionId,
        enabled: next,
      });
    }
  }, [commitBypass, session.sessionId]);

  const toggleAudit = useCallback(() => {
    const next = !auditBypass;
    setAuditBypass(next);
    if (session.sessionId) {
      postMessage({
        type: "toggleAuditBypass",
        sessionId: session.sessionId,
        enabled: next,
      });
    }
  }, [auditBypass, session.sessionId]);

  const addImages = useCallback(
    async (files: FileList | File[]) => {
      const fileArr = Array.from(files).filter((f) => isImageType(f.type));
      if (fileArr.length === 0) return;
      const remaining = MAX_IMAGES - images.length;
      if (remaining <= 0) return;
      const toProcess = fileArr.slice(0, remaining);
      const rawUris = await Promise.all(toProcess.map((f) => fileToDataUri(f)));
      const compressed = await Promise.all(
        rawUris.map((uri) => compressImage(uri)),
      );
      setImages((curr) => [...curr, ...compressed].slice(0, MAX_IMAGES));
    },
    [images.length],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (isImageType(items[i].type)) {
          const file = items[i].getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        addImages(imageFiles);
      }
    },
    [addImages],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer?.files) {
        addImages(e.dataTransfer.files);
      }
    },
    [addImages],
  );

  const removeImage = useCallback((idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const sendFeedback = () => {
    const value = feedbackRef.current?.value.trim();
    if ((!value && images.length === 0) || !session.sessionId) return;

    // If enricher is enabled, request enrichment first
    if (enrichEnabled && value && !enrichResult) {
      setEnrichLoading(true);
      postMessage({ type: "enrichFeedback", feedback: value, sessionId: session.sessionId, lastSynthesis: session.pendingSynthesis, loopGoal: session.goal });
      return;
    }

    postMessage({
      type: "loopFeedback",
      feedback: value || "(imágenes adjuntas)",
      sessionId: session.sessionId,
      images: images.length > 0 ? images : undefined,
    });
    if (feedbackRef.current) feedbackRef.current.value = "";
    setImages([]);
    setEnrichResult(null);
    setSent(true);
    setTimeout(() => setSent(false), 2500);
  };

  const sendEnriched = (rewrittenPrompt: string) => {
    if (!session.sessionId) return;
    postMessage({
      type: "loopFeedback",
      feedback: rewrittenPrompt,
      sessionId: session.sessionId,
      images: images.length > 0 ? images : undefined,
    });
    if (feedbackRef.current) feedbackRef.current.value = "";
    setImages([]);
    setEnrichResult(null);
    setSent(true);
    setTimeout(() => setSent(false), 2500);
  };

  const dismissEnrichResult = () => {
    setEnrichResult(null);
  };

  const currentIterations = session.currentLoopIterations ?? session.iterations?.length ?? 0;
  // Config file (via session.maxCycles) is the single source of truth.
  // globalMaxCycles only as fallback when session has no per-session value.
  const maxCycles = session.maxCycles ?? globalMaxCycles ?? undefined;
  const isMigrationNeeded = maxCycles != null && currentIterations >= maxCycles;
  const remaining =
    maxCycles != null ? maxCycles - currentIterations : undefined;

  const sendMigration = () => {
    if (migrating) return;
    setMigrating(true);
    const value = feedbackRef.current?.value.trim();
    if (!value || !session.sessionId) return;
    postMessage({
      type: "loopMigrate",
      feedback: value,
      sessionId: session.sessionId,
    });
    if (feedbackRef.current) feedbackRef.current.value = "";
    setImages([]);
    setSent(true);
  };

  const addOneIteration = () => {
    if (!session.sessionId) return;
    postMessage({
      type: "addIterations",
      sessionId: session.sessionId,
      amount: 1,
    });
  };

  const submitMaxCyclesEdit = () => {
    const val = parseInt(editValue, 10);
    if (!session.sessionId || isNaN(val) || val < 1) {
      setEditingMaxCycles(false);
      return;
    }
    postMessage({
      type: "setMaxCycles",
      sessionId: session.sessionId,
      maxCycles: val,
    });
    setEditingMaxCycles(false);
  };

  const copyToClipboard = useCallback(() => {
    if (!session.pendingSynthesis) return;
    navigator.clipboard.writeText(session.pendingSynthesis).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [session.pendingSynthesis]);

  const handlePanelClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (
      target.tagName !== "TEXTAREA" &&
      target.tagName !== "INPUT" &&
      target.tagName !== "BUTTON" &&
      !target.closest("button") &&
      !target.closest("input") &&
      !target.closest("label")
    ) {
      feedbackRef.current?.focus();
    }
  }, []);

  if (!session.awaitingFeedback || !session.pendingSynthesis) return null;

  return (
    <div
      ref={panelRef}
      onClick={handlePanelClick}
      className="mt-4 p-4 bg-vsc-header border-2 border-vsc-accent rounded-lg">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-semibold">🧠 Síntesis del agente:</div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={copyToClipboard}
            className="text-[11px] px-2 py-0.5 rounded border border-vsc-border text-vsc-fg hover:bg-vsc-header cursor-pointer"
            title="Copiar síntesis">
            {copied ? "✓ Copiado" : "📋 Copiar"}
          </button>
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-[11px] px-2 py-0.5 rounded border border-vsc-border text-vsc-fg hover:bg-vsc-header cursor-pointer"
            title={expanded ? "Colapsar síntesis" : "Expandir síntesis"}>
            {expanded ? "▲ Colapsar" : "▼ Expandir"}
          </button>
        </div>
      </div>
      <div
        className={`text-xs leading-relaxed p-4 bg-vsc-bg border border-vsc-border rounded-md mb-3 overflow-y-auto`}
        style={expanded ? { maxHeight: "80vh" } : { maxHeight: "200px" }}>
        <div className="prose prose-sm prose-invert max-w-none [&>p]:mb-2 [&>ul]:ml-4 [&>ul]:list-disc [&>ol]:ml-4 [&>ol]:list-decimal [&>h1]:text-base [&>h2]:text-sm [&>h3]:text-xs [&>h1]:font-bold [&>h2]:font-semibold [&>h3]:font-semibold [&>h1]:mb-2 [&>h2]:mb-1.5 [&>h3]:mb-1 [&>pre]:bg-black/30 [&>pre]:p-2 [&>pre]:rounded [&>pre]:text-[11px] [&>blockquote]:border-l-2 [&>blockquote]:border-vsc-accent [&>blockquote]:pl-3 [&>blockquote]:opacity-80">
          <Markdown content={session.pendingSynthesis} />
        </div>
      </div>
      <div className="text-sm font-semibold mb-1.5">📨 Tu feedback:</div>
      <div
        className={`relative rounded-md border ${dragOver ? "border-vsc-accent border-dashed bg-vsc-accent/10" : "border-vsc-border"} bg-vsc-bg`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}>
        <textarea
          ref={feedbackRef}
          rows={3}
          placeholder="Escribe tu feedback aquí... (puedes pegar imágenes con Ctrl+V o arrastrar)"
          aria-label="Write your feedback"
          className="w-full p-2 text-xs rounded-md bg-transparent text-vsc-fg resize-y border-none outline-none"
          onPaste={handlePaste}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              isMigrationNeeded ? sendMigration() : sendFeedback();
            }
          }}
        />
        {dragOver && (
          <div className="absolute inset-0 flex items-center justify-center bg-vsc-accent/20 rounded-md pointer-events-none">
            <span className="text-sm font-semibold text-vsc-accent">
              📷 Soltar imagen aquí
            </span>
          </div>
        )}
      </div>

      {/* Image previews */}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-2">
          {images.map((uri, idx) => (
            <div
              key={idx}
              className="relative group w-16 h-16 rounded-md overflow-hidden border border-vsc-border">
              <img
                src={uri}
                alt={`Adjunto ${idx + 1}`}
                className="w-full h-full object-cover"
              />
              <button
                onClick={() => removeImage(idx)}
                className="absolute top-0 right-0 w-4 h-4 bg-red-600 text-white text-[10px] leading-none rounded-bl opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                title="Eliminar imagen">
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Migration disclaimer */}
      {isMigrationNeeded && (
        <div className="mt-2 px-3 py-1.5 text-[11px] rounded-md bg-yellow-900/30 border border-yellow-600/40 text-yellow-200">
          ⚠️ Máx. iteraciones alcanzado ({currentIterations}/{maxCycles}). La
          próxima iteración será en un chat nuevo.
        </div>
      )}

      <div className="flex items-center gap-2 mt-2">
        <button
          disabled={isMigrationNeeded && migrating}
          onClick={isMigrationNeeded ? sendMigration : sendFeedback}
          className={`px-4 py-1.5 text-xs font-semibold rounded-md cursor-pointer ${
            isMigrationNeeded
              ? "bg-yellow-600 text-white hover:bg-yellow-500"
              : "bg-vsc-accent text-white hover:opacity-90"
          }`}>
          {isMigrationNeeded
            ? migrating
              ? "⏳ Migrando..."
              : "📨 Enviar y Migrar"
            : "📨 Enviar Feedback"}
        </button>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="px-3 py-1.5 text-xs rounded-md border border-vsc-border text-vsc-fg hover:bg-vsc-header cursor-pointer"
          title="Adjuntar imagen">
          📷 Imagen
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addImages(e.target.files);
            e.target.value = "";
          }}
        />
        {sent && <span className="text-[11px] text-green-400">✓ Enviado</span>}
        <span className="text-[10px] opacity-50 ml-auto flex items-center gap-1.5">
          {images.length > 0 && `${images.length}/${MAX_IMAGES} imgs · `}
          {maxCycles != null && (
            <>
              {editingMaxCycles ? (
                <input
                  ref={maxCyclesInputRef}
                  type="number"
                  min={1}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={submitMaxCyclesEdit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitMaxCyclesEdit();
                    if (e.key === "Escape") setEditingMaxCycles(false);
                  }}
                  className="w-10 text-[10px] text-center bg-vsc-bg border border-vsc-accent rounded px-0.5 text-vsc-fg outline-none"
                />
              ) : (
                <span
                  className={`cursor-pointer hover:text-vsc-accent ${
                    remaining != null && remaining <= 2 ? "text-yellow-400" : ""
                  }`}
                  onDoubleClick={() => {
                    setEditValue(String(maxCycles));
                    setEditingMaxCycles(true);
                  }}
                  title="Doble-click para editar máximo">
                  {currentIterations}/{maxCycles}
                </span>
              )}
              <button
                onClick={addOneIteration}
                className="text-[10px] px-1 py-0 rounded border border-vsc-border/50 hover:bg-vsc-header hover:border-vsc-accent cursor-pointer leading-tight"
                title="Agregar 1 iteración">
                ▲
              </button>
              <span className="opacity-60">·</span>
            </>
          )}
          Ctrl+Enter
        </span>
      </div>

      {/* ── Enricher Preview ── */}
      <EnrichPreview
        result={enrichResult}
        source="feedback"
        onAccept={sendEnriched}
        onReject={dismissEnrichResult}
        loading={enrichLoading}
      />

      {/* ── Gate Bypass Toggles ── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 pt-2 border-t border-vsc-border/40">
        <label className="flex items-center gap-1.5 cursor-pointer text-[11px]">
          <input
            type="checkbox"
            checked={!commitBypass}
            onChange={toggleBypass}
            className="accent-vsc-accent"
          />
          <span className={!commitBypass ? "text-green-300" : "opacity-60"}>
            🔒 Activate commit gate
          </span>
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer text-[11px]">
          <input
            type="checkbox"
            checked={auditBypass}
            onChange={toggleAudit}
            className="accent-vsc-accent"
          />
          <span className={auditBypass ? "text-yellow-300" : "opacity-60"}>
            📇 Skip audit gate
          </span>
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer text-[11px]">
          <input
            type="checkbox"
            checked={enrichEnabled}
            onChange={(e) => setEnrichEnabled(e.target.checked)}
            className="accent-vsc-accent"
          />
          <span className={enrichEnabled ? "text-blue-300" : "opacity-60"}>
            🧠 Enrich with memory
          </span>
        </label>
        <span className="text-[10px] opacity-30">
          {commitBypass && auditBypass
            ? "(sin gates — modo libre)"
            : !commitBypass && !auditBypass
              ? "(ambos gates activos)"
              : !commitBypass
                ? "(commit gate on)"
                : "(audit gate off)"}
        </span>
      </div>
    </div>
  );
}
