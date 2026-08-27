import { useEffect, useRef, type ReactNode } from "react";
import { useI18n } from "../i18n";

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      window.requestAnimationFrame(() => cancelRef.current?.focus());
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="app-confirm-dialog"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const first = cancelRef.current;
        const last = confirmRef.current;
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <div className="app-confirm-dialog__panel">
        <div className="app-confirm-dialog__eyebrow">{t("common.confirm")}</div>
        <h2 id="confirm-dialog-title">{title}</h2>
        <p id="confirm-dialog-description">{description}</p>
        <div className="app-confirm-dialog__actions">
          <button type="button" ref={cancelRef} className="app-button app-button--secondary" disabled={busy} onClick={onCancel}>{busy ? t("common.wait") : cancelLabel}</button>
          <button type="button" ref={confirmRef} className="app-button app-button--danger" disabled={busy} onClick={onConfirm}>{busy ? `${confirmLabel.replace(/^Remove\s+/i, "Removing ").replace(/^Delete\s+/i, "Deleting ").replace(/^Restart\s+/i, "Restarting ")}…` : confirmLabel}</button>
        </div>
      </div>
    </dialog>
  );
}

export type { ConfirmDialogProps };
