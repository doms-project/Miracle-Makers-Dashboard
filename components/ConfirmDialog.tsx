"use client";

import ErrorMessage from "./ErrorMessage";

export default function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  danger,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  error?: unknown;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="previewmodal" onClick={busy ? undefined : onCancel}>
      <div
        className="movebox confirmbox"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
      >
        <div className="previewhead">
          <span className="previewname">{title}</span>
          <button
            className="x"
            type="button"
            onClick={onCancel}
            disabled={busy}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="movebody">
          <div className="confirmtext">{body}</div>
          <ErrorMessage error={error} />
          <div className="inav">
            <button
              type="button"
              className="ighost"
              onClick={onCancel}
              disabled={busy}
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              className={danger ? "ibtn danger" : "ibtn"}
              onClick={onConfirm}
              disabled={busy}
            >
              {busy ? "Working…" : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
