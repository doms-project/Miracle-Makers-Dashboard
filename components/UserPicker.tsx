"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export interface PickableUser {
  id: string;
  name: string;
  divisions?: string[];
}

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
