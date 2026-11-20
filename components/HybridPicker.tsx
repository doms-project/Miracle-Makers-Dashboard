"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import ErrorMessage from "./ErrorMessage";

export interface HybridUser {
  id: string;
  name: string;
  divisions?: string[];
}

export default function HybridPicker({
  fieldId,
  fieldName,
  users,
  options,
  value,
  multi,
  disabled,
  isAdmin,
  ssoBlob,
  onChange,
  onOptionAdded,
}: {
  fieldId: string;
  fieldName: string;
  users: HybridUser[];
  options: string[];
  value: string | string[];
  multi?: boolean;
  disabled?: boolean;
  isAdmin: boolean;
  ssoBlob: string | null;
  onChange: (v: string | string[]) => void;

  onOptionAdded?: (fieldId: string, options: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => (Array.isArray(value) ? value.map(String) : value ? [String(value)] : []),
    [value],
  );

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
        setAdding(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {

      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        setAdding(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const { userRows, extRows } = useMemo(() => {
    const userNames = new Set(users.map((u) => u.name.trim().toLowerCase()));
    const ext = options
      .map((o) => o.trim())
      .filter((o) => o && !userNames.has(o.toLowerCase()));
    return { userRows: users, extRows: ext };
  }, [users, options]);

  const needle = q.trim().toLowerCase();
  const shownUsers = needle
    ? userRows.filter((u) => u.name.toLowerCase().includes(needle))
    : userRows;
  const shownExt = needle
    ? extRows.filter((o) => o.toLowerCase().includes(needle))
    : extRows;

  const pick = (name: string) => {
    if (multi) {
      const has = selected.some((s) => s.toLowerCase() === name.toLowerCase());
      onChange(
        has
          ? selected.filter((s) => s.toLowerCase() !== name.toLowerCase())
          : [...selected, name],
      );
    } else {
      onChange(name);
      setOpen(false);
      setQ("");
    }
  };

  const addName = async () => {
    const v = newName.trim();
    if (!v || busy) return;
    setBusy(true);
    setErr(null);
    try {

      const j = await apiFetch<{ ok?: boolean; options?: string[] }>(
        `/api/fields/${encodeURIComponent(fieldId)}/options`,
        {
          method: "POST",
          ssoBlob,
          body: JSON.stringify({ ssoKey: ssoBlob ?? undefined, option: v }),
        },
      );
      onOptionAdded?.(fieldId, j.options || [...options, v]);
      setNewName("");
      setAdding(false);
      pick(v);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const label = selected.length ? selected.join(", ") : "—";

  return (
    <div className="uppick" ref={boxRef}>
      <button
        type="button"
        className={`upbtn ${open ? "on" : ""}`}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="upbtnlabel">
          <span className="upbtnname">{label}</span>
        </span>
        <span className="upcaret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open ? (
        <div className="upmenu" role="listbox">
          <input
            className="cgsearch upsearch"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Filter ${fieldName.toLowerCase()}…`}
            autoFocus
          />
          {isAdmin ? (
            <div className="upadd">
              {adding ? (
                <>
                  <input
                    className="cgsearch"
                    value={newName}
                    disabled={busy}
                    placeholder="Full name"
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addName();
                    }}
                    autoFocus
                  />
                  <div className="upaddacts">
                    <button
                      type="button"
                      className="ighost"
                      disabled={busy}
                      onClick={() => {
                        setAdding(false);
                        setErr(null);
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="ibtn"
                      disabled={busy || !newName.trim()}
                      onClick={addName}
                    >
                      {busy ? "Adding…" : "Add"}
                    </button>
                  </div>
                  <div className="imeta">
                    Adds the name to this field in GoHighLevel, for every record.
                  </div>
                  <ErrorMessage error={err} />
                </>
              ) : (
                <button
                  type="button"
                  className="upaddbtn"
                  onClick={() => setAdding(true)}
                >
                  + Add name…
                </button>
              )}
            </div>
          ) : null}

          <div className="uplist">
            {!multi ? (
              <button
                type="button"
                className={`uprow ${!selected.length ? "sel" : ""}`}
                onClick={() => pick("")}
              >
                <span className="uprowname">—</span>
              </button>
            ) : null}

            {shownUsers.map((u) => {
              const on = selected.some(
                (s) => s.toLowerCase() === u.name.toLowerCase(),
              );
              return (
                <button
                  key={u.id}
                  type="button"
                  className={`uprow ${on ? "sel" : ""}`}
                  onClick={() => pick(u.name)}
                >
                  <span className="uprowname">
                    {multi ? (on ? "✓ " : "") : ""}
                    {u.name}
                  </span>
                  <span className="upchip">
                    {u.divisions?.length
                      ? u.divisions.join(" · ")
                      : "No division"}
                  </span>
                </button>
              );
            })}

            {shownExt.length ? (
              <div className="updiv">Not GoHighLevel users</div>
            ) : null}
            {shownExt.map((o) => {
              const on = selected.some((s) => s.toLowerCase() === o.toLowerCase());
              return (
                <button
                  key={o}
                  type="button"
                  className={`uprow ${on ? "sel" : ""}`}
                  onClick={() => pick(o)}
                >
                  <span className="uprowname">
                    {multi ? (on ? "✓ " : "") : ""}
                    {o}
                    <span className="extbadge">ext</span>
                  </span>
                </button>
              );
            })}

            {selected
              .filter(
                (s) =>
                  s &&
                  !userRows.some(
                    (u) => u.name.toLowerCase() === s.toLowerCase(),
                  ) &&
                  !extRows.some((o) => o.toLowerCase() === s.toLowerCase()),
              )
              .map((s) => (
                <button key={s} type="button" className="uprow sel" onClick={() => pick(s)}>
                  <span className="uprowname">
                    {s}
                    <span className="extbadge">not in list</span>
                  </span>
                </button>
              ))}

            {!shownUsers.length && !shownExt.length ? (
              <div className="cgmuted" style={{ padding: "10px 12px" }}>
                No match.
              </div>
            ) : null}
          </div>

        </div>
      ) : null}
    </div>
  );
}
