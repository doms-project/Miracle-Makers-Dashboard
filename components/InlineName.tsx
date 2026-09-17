"use client";

import { useEffect, useRef, useState } from "react";
import ErrorMessage from "./ErrorMessage";

/**
 * 🔴 ROUND 131 — RENAME IN PLACE, AND SAY WHICH NAME IS BEING RENAMED.
 *
 * Two names sit in the record panel's header and they are not the same thing:
 *
 *   the OPPORTUNITY name   this case only
 *   the CONTACT name       the person, on every record they hold
 *
 * ⚠️ THE DISTINCTION IS THE FEATURE, NOT DECORATION. A rep fixing "Mary
 * Malonne" has to know whether they are fixing it once or everywhere, and the
 * two controls are three millimetres apart. So the scope sentence is not a
 * tooltip and not a hint under a Save button — it is shown the moment the
 * editor opens, in the same words the field sections already use.
 *
 * ⚠️ NO OPTIMISTIC PAINT AND NO BLUR-TO-SAVE. Both names are NATIVE GoHighLevel
 * fields, which answer 200 to writes they discard, so the caller's save reads
 * the value back and can fail. Showing the new spelling before that returns
 * would show a rename that did not happen. Blur-to-save is left out for the
 * same reason a name is not a checkbox: clicking away is not an instruction.
 *
 * Enter saves · Escape cancels · the buttons do both explicitly.
 */
export default function InlineName({
  display,
  parts,
  scope,
  editLabel,
  busy,
  err,
  disabled,
  heading,
  onSave,
}: {
  /** What the name reads as when nobody is editing it. */
  display: string;
  /** One box, or two for a first/last pair. `key` is what onSave is given. */
  parts: { key: string; label: string; value: string }[];
  /** 🔴 WHICH NAME THIS IS. Shown while editing, never hidden behind a hover. */
  scope: React.ReactNode;
  /** The button's accessible name — "Rename this case" / "Rename this person". */
  editLabel: string;
  busy?: boolean;
  err?: unknown;
  disabled?: boolean;
  /** The opportunity name is the panel's heading; the person's name is not. */
  heading?: boolean;
  onSave: (values: Record<string, string>) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const firstBox = useRef<HTMLInputElement | null>(null);

  // Reopening on a different record must not carry the last one's draft.
  useEffect(() => {
    if (!open) return;
    setDraft(Object.fromEntries(parts.map((p) => [p.key, p.value])));
    // The focus lands on the first box with its text selected: "click the name,
    // type" only works if typing replaces what is there.
    const t = setTimeout(() => {
      firstBox.current?.focus();
      firstBox.current?.select();
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = () => setOpen(false);
  const commit = async () => {
    const values = Object.fromEntries(
      parts.map((p) => [p.key, (draft[p.key] ?? "").trim()]),
    );
    // Unchanged is not a save. It would spend a write and a read-back to store
    // what is already there, and on the contact path it would bump the version
    // every other panel is holding.
    if (parts.every((p) => values[p.key] === p.value.trim())) return close();
    if (await onSave(values)) close();
  };

  const Rest = heading ? "h2" : "div";
  if (!open)
    return (
      <Rest className={heading ? "inmhead" : "inmline"}>
        {!heading ? <span className="inmwhat">Person</span> : null}
        <button
          type="button"
          className="inmbtn"
          onClick={() => setOpen(true)}
          disabled={disabled}
          title={disabled ? "You can only rename records you own or follow." : editLabel}
          aria-label={`${editLabel}. Currently ${display || "unnamed"}.`}
        >
          <span className="inmval">{display || "Unnamed"}</span>
          {!disabled ? <span className="inmpen" aria-hidden="true">✎</span> : null}
        </button>
        {/* ⚠️ THE ERROR SURVIVES THE EDITOR CLOSING. A failed rename that took
            its message away with it would look like a save. */}
        {err ? <ErrorMessage error={err} /> : null}
      </Rest>
    );

  return (
    // 🔴 `data-esc-local` — THE PAGE'S DOCUMENT-LEVEL ESCAPE HANDLER CLOSES THE
    // WHOLE RECORD PANEL. Escape here means "cancel this rename", and without
    // this marker it meant both: the edit was dropped and the record shut
    // behind it. See the handler in app/page.tsx.
    <div className="inmedit" data-esc-local>
      <div className="inmscope">{scope}</div>
      <div className="inmboxes">
        {parts.map((p, i) => (
          <input
            key={p.key}
            ref={i === 0 ? firstBox : undefined}
            className="inminput"
            value={draft[p.key] ?? ""}
            aria-label={p.label}
            placeholder={p.label}
            disabled={busy}
            onChange={(e) =>
              setDraft((d) => ({ ...d, [p.key]: e.target.value }))
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
            }}
          />
        ))}
      </div>
      <div className="inmacts">
        <button type="button" className="inmsave" onClick={() => void commit()} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" className="inmcancel" onClick={close} disabled={busy}>
          Cancel
        </button>
      </div>
      {err ? <ErrorMessage error={err} /> : null}
    </div>
  );
}
