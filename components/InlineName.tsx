"use client";

import { useEffect, useRef, useState } from "react";
import ErrorMessage from "./ErrorMessage";

export default function InlineName({
  display,
  parts,
  scope,
  editLabel,
  busy,
  err,
  disabled,
  heading,
  what,
  link,
  empty,
  onSave,
}: {

  display: string;

  parts: { key: string; label: string; value: string }[];

  scope: React.ReactNode;

  editLabel: string;
  busy?: boolean;
  err?: unknown;
  disabled?: boolean;

  heading?: boolean;

  what?: string;

  link?: string;

  empty?: string;
  onSave: (values: Record<string, string>) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const firstBox = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(Object.fromEntries(parts.map((p) => [p.key, p.value])));

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

    if (parts.every((p) => values[p.key] === p.value.trim())) return close();
    if (await onSave(values)) close();
  };

  const Rest = heading ? "h2" : "div";
  const pencil = (
    <button
      type="button"
      className="inmpenbtn"
      onClick={() => setOpen(true)}
      disabled={disabled}
      title={disabled ? "You can only edit records you own or follow." : editLabel}
      aria-label={`${editLabel}. Currently ${display || "not set"}.`}
    >
      ✎
    </button>
  );
  if (!open)
    return (
      <Rest className={heading ? "inmhead" : "inmline"}>
        {!heading && what ? <span className="inmwhat">{what}</span> : null}

        {link && display ? (
          <>
            <a className="inmbtn inmanchor" href={link}>
              <span className="inmval">{display}</span>
            </a>
            {pencil}
          </>
        ) : (
          <button
            type="button"
            className="inmbtn"
            onClick={() => setOpen(true)}
            disabled={disabled}
            title={disabled ? "You can only edit records you own or follow." : editLabel}
            aria-label={`${editLabel}. Currently ${display || empty || "not set"}.`}
          >
            <span className={`inmval${!display ? " inmnone" : ""}`}>
              {display || empty || "Unnamed"}
            </span>
            {!disabled ? <span className="inmpen" aria-hidden="true">✎</span> : null}
          </button>
        )}

        {err ? <ErrorMessage error={err} /> : null}
      </Rest>
    );

  return (

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
