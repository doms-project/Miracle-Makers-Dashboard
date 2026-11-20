"use client";

import { useState } from "react";
import { explainError } from "@/lib/errors";

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
