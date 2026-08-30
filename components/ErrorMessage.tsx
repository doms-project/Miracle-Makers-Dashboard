"use client";

import { useState } from "react";
import { explainError } from "@/lib/errors";

// The ONE place an error is shown. Every call site renders this, so the next
// error worth translating is mapped once in lib/errors.ts rather than twenty
// times here.
//
// Plain sentence always visible; the technical block behind a disclosure,
// collapsed by default, selectable, with a copy button — so a rep can screenshot
// it or paste it to us without reading it.
export default function ErrorMessage({
  error,
  className = "savemsg err",
  style,
}: {
  error: unknown;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [copied, setCopied] = useState(false);
  if (error == null) return null;

  const { message, details, unmapped } = explainError(error);
  const block = details.join("\n");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(block);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard is blocked in some embedded contexts. The text is selectable
      // either way, so this failing costs nothing — but never claim it worked.
      setCopied(false);
    }
  };

  return (
    <div className={className} style={style}>
      <div className="errmsg">✗ {message}</div>
      {details.length ? (
        <details className="errdetails">
          <summary>
            Details
            {/* An unmapped error is worth flagging: it tells us there's a case
                to add to the map, and tells the rep the detail matters. */}
            {unmapped ? <span className="errnew">unrecognised</span> : null}
          </summary>
          <pre className="errpre">{block}</pre>
          <button type="button" className="errcopy" onClick={copy}>
            {copied ? "Copied" : "Copy details"}
          </button>
        </details>
      ) : null}
    </div>
  );
}
