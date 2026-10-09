import { useEffect, useRef } from "react";

export function EndConfirmDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Confirmar cierre de loop"
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="bg-vsc-bg border border-vsc-border rounded-lg p-5 max-w-sm shadow-xl outline-none">
        <div className="text-sm font-semibold mb-2">🛑 ¿Cerrar este loop?</div>
        <p className="text-xs opacity-70 mb-4 leading-relaxed">
          El loop se cerrará permanentemente. Si tiene branch isolation, podrás
          hacer merge o descartar los cambios después.
        </p>
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded-md bg-vsc-header border border-vsc-border hover:opacity-90 cursor-pointer">
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 text-xs font-semibold rounded-md bg-vsc-error text-white hover:opacity-90 cursor-pointer">
            Sí, cerrar loop
          </button>
        </div>
      </div>
    </div>
  );
}
