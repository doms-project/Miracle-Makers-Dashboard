"use client";

import ErrorMessage from "./ErrorMessage";

// ITEM 2 — an in-app confirmation, same shape as the Move dialog.
//
// This replaces `window.confirm()`, which was wrong here for three reasons, the
// third of which was breaking the feature outright:
//
//   1. it can't be styled, so it reads as a browser warning rather than part of
//      the app;
//   2. it blocks the whole tab and can only show one line of plain text — no
//      room to say what "removed" actually means;
//   3. THE DASHBOARD RUNS INSIDE AN IFRAME in GoHighLevel (lib/useGhlSession.ts
//      talks to `window.parent` over postMessage). A sandboxed iframe without
//      `allow-modals` makes `confirm()` return FALSE without ever prompting —
//      so the caller bails out and NOTHING HAPPENS, silently. That is the
//      reported symptom exactly.
//
// Never use window.confirm / alert / prompt in this app. Use this.
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
