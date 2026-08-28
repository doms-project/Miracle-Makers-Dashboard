"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export interface PickableUser {
  id: string;
  name: string;
  divisions?: string[];
}

// ITEM 2 — replaces the native <select> for owner / follower.
//
// The problem: a native <option> is one line of unstyleable text, so a GHL name
// that already carries a role suffix plus the division ran together as
//
//     "Jhune Manalaysay - Onboarding — —"
//
// Option (b) was chosen: name on its own line, division as a muted chip below.
// Same shape as the caregiver typeahead already in the panel, so it reuses that
// visual language (and most of its CSS).
//
// The role suffix is deliberately KEPT rather than stripped: it disambiguates
// two people who share a first name, and it is no longer competing for the same
// line as the division, which was the actual complaint.
//
// Expect a lot of "No division" — only a handful of the location's users are
// mapped in the access map. That is accurate, not a bug, so it reads as a quiet
// muted label rather than an em dash that looks like a rendering fault.
export default function UserPicker({
  users,
  value,
  onChange,
  disabled,
  placeholder = "Unassigned",
  allowUnassigned = true,
  emptyLabel = "No users available",
  triggerLabel,
}: {
  users: PickableUser[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  placeholder?: string;
  allowUnassigned?: boolean;
  emptyLabel?: string;
  // When set, the button always shows this instead of the selection — used by
  // the "+ Add follower…" case, which is an action rather than a value.
  triggerLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = users.find((u) => u.id === value) || null;

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node))
        setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      // Stop Escape here — the panel also listens for it, and closing the whole
      // record because you dismissed a dropdown would be its own bug.
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return users;
    return users.filter(
      (u) =>
        u.name.toLowerCase().includes(needle) ||
        (u.divisions || []).some((d) => d.toLowerCase().includes(needle)),
    );
  }, [users, q]);

  const label =
    triggerLabel ??
    (value
      ? selected?.name || "Former user"
      : placeholder);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setQ("");
  };

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
          {!triggerLabel && selected ? (
            <span className="upchip">
              {selected.divisions?.length
                ? selected.divisions.join(" · ")
                : "No division"}
            </span>
          ) : null}
        </span>
        <span className="upcaret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open ? (
        <div className="upmenu" role="listbox">
          <input
            ref={inputRef}
            className="cgsearch upsearch"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by name or division…"
          />
          <div className="uplist">
            {allowUnassigned ? (
              <button
                type="button"
                className={`uprow ${!value ? "sel" : ""}`}
                onClick={() => pick("")}
              >
                <span className="uprowname">{placeholder}</span>
              </button>
            ) : null}
            {shown.length ? (
              shown.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  className={`uprow ${u.id === value ? "sel" : ""}`}
                  onClick={() => pick(u.id)}
                >
                  <span className="uprowname">{u.name}</span>
                  <span className="upchip">
                    {u.divisions?.length
                      ? u.divisions.join(" · ")
                      : "No division"}
                  </span>
                </button>
              ))
            ) : (
              <div className="cgmuted" style={{ padding: "10px 12px" }}>
                {users.length ? "No match." : emptyLabel}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
